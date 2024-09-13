import * as events from 'events';
import retry, { FailedAttemptError } from 'p-retry';
import { TimeoutsOptions } from 'retry';

export enum ResourceStatus {
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error',
    Closing = 'closing',
    Closed = 'closed',
}

export interface ResourceRetryError extends FailedAttemptError {}

export interface ResourceRetry extends TimeoutsOptions {}

export type ResourceEvent = 'open' | 'close' | 'error' | 'status' | 'retry';

export interface Resource extends events.EventEmitter {
    close(): Promise<void>;
}

export type ResourceFactory<T extends Resource> = () => Promise<T>;

export type ResourceCloser<T extends Resource> = (res: T) => Promise<void>;

export interface ResourceHandlerOptions<T extends Resource> {
    name: string;
    closer?: ResourceCloser<T>;
    retry?: ResourceRetry;
    eventBindings?: string[];
}

export class ResourceHandler<T extends Resource> extends events.EventEmitter {
    private __resource: Promise<T | null>;
    private __factory: ResourceFactory<T>;
    private __err?: Error;
    private __status: ResourceStatus;
    private __opts: ResourceHandlerOptions<T>;
    private isReconnecting: boolean = false;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 5;
    private readonly reconnectDelay: number = 5000;

    constructor(factory: ResourceFactory<T>, opts?: ResourceHandlerOptions<T>) {
        super();

        this.__opts = {
            name: opts?.name || 'Resource',
            closer: opts?.closer,
            eventBindings: opts?.eventBindings,
            retry: {
                retries: opts?.retry?.retries || 10,
                minTimeout: opts?.retry?.minTimeout || 5000,
                maxTimeout: opts?.retry?.maxTimeout || Infinity,
                factor: opts?.retry?.factor || 2,
                randomize: opts?.retry?.randomize || false,
            },
        };
        this.__factory = factory;
        this.__status = ResourceStatus.Connecting;
        this.__resource = undefined as any;
        this.__connect(true);
    }

    public get status(): ResourceStatus {
        return this.__status;
    }

    public get error(): Error | undefined {
        return this.__err;
    }

    public async resource(): Promise<T> {
        const res = await this.__resource;

        if (!res) {
            return Promise.reject(new Error(`${this.__opts.name} is not available`));
        }

        return res;
    }

    public async connect(): Promise<void> {
        this.__connect();

        await this.__resource;
    }

    public async close(): Promise<void> {
        if (this.__status === ResourceStatus.Closed) {
            return Promise.reject(new Error(`${this.__opts.name} is closed`));
        }

        if (this.__status === ResourceStatus.Connecting) {
            this.__setStatus(ResourceStatus.Closing);

            return Promise.resolve();
        }

        this.__setStatus(ResourceStatus.Closed);

        const res = await this.__resource;

        if (res == null) {
            return Promise.resolve();
        }

        res.removeAllListeners();

        if (this.__opts.closer) {
            return this.__opts.closer(res);
        }

        return res.close();
    }

    private __subscribe(res: T): void {
        res.once('error', (err) => {
            res.removeAllListeners();
            this.__err = err;
            this.__setStatus(ResourceStatus.Error);
            this.__handleReconnect();
            this.emit('error', err);
        });

        res.once('close', () => {
            res.removeAllListeners();
            this.__setToClose();
        });

        if (Array.isArray(this.__opts.eventBindings)) {
            this.__opts.eventBindings.forEach((i) => {
                res.on(i, (...args) => {
                    this.emit(i, ...args);
                });
            });
        }
    }

    private async __handleReconnect(): Promise<void> {
        if (this.isReconnecting) {
            console.log(`[ResourceHandler] Reconnection already in progress for: ${this.__opts.name}`);
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts = 0;

        while (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`[ResourceHandler] Attempting to reconnect. Attempt ${this.reconnectAttempts} for: ${this.__opts.name}`);

            await this.__delay(this.reconnectDelay);

            try {
                await this.__connect(true);
                console.log(`[ResourceHandler] Reconnection successful after ${this.reconnectAttempts} attempts for: ${this.__opts.name}`);
                this.isReconnecting = false;
                return;
            } catch (error) {
                console.error(`[ResourceHandler] Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`);
            }
        }

        console.error(`[ResourceHandler] Max reconnection attempts reached for: ${this.__opts.name}`);
        this.isReconnecting = false;
        // Démarrer les tentatives de reconnexion périodiques
        this.__startPeriodicReconnect();
    }

    private __connect(force: boolean = false): void {
        if (!force) {
            if (
                this.__status === ResourceStatus.Connecting ||
                this.__status === ResourceStatus.Connected ||
                this.__status === ResourceStatus.Closing ||
                this.__status === ResourceStatus.Closed
            ) {
                return;
            }
        }

        this.__setStatus(ResourceStatus.Connecting);
        this.__err = undefined;

        this.__resource = retry(
            () => {
                if (this.__status === ResourceStatus.Closing) {
                    this.__setToClose();

                    throw new retry.AbortError(`Connection is aborted`);
                }

                return this.__factory();
            },
            Object.assign(
                {
                    onFailedAttempt: (err: FailedAttemptError) => {
                        this.emit('retry', err);
                    },
                },
                this.__opts.retry,
            ),
        )
            .then((res: T) => {
                if (this.__status === ResourceStatus.Closing) {
                    this.__setToClose();

                    return Promise.reject(
                        new Error(`${this.__opts.name} is closed`),
                    );
                }

                this.__subscribe(res);
                this.__setStatus(ResourceStatus.Connected);

                this.emit('open');

                return res;
            })
            .catch((err) => {
                this.__err = err;
                this.__setStatus(ResourceStatus.Error);

                this.emit('error', err);

                return Promise.resolve(null);
            });
    }

    private async __setToClose(): Promise<void> {
        console.log(`[ResourceHandler] Attempting to close resource: ${this.__opts.name}`);

        try {
            if (this.isReconnecting) {
                console.log(`[ResourceHandler] Reconnection in progress, delaying closure for: ${this.__opts.name}`);
                return;
            }

            console.log(`[ResourceHandler] Attempting to reconnect before closing: ${this.__opts.name}`);
            await this.__attemptReconnect();

            if (this.__status === ResourceStatus.Connected) {
                console.log(`[ResourceHandler] Reconnection successful, resource will not be closed: ${this.__opts.name}`);
                return;
            }
        } catch (reconnectError) {
            console.error(`[ResourceHandler] Failed to reconnect: ${reconnectError.message}`);
            this.__startPeriodicReconnect();
            // Ne pas fermer la ressource ici
            return;
        }

    }

    private async __startPeriodicReconnect(): Promise<void> {
        console.log(`[ResourceHandler] Starting periodic reconnection for resource: ${this.__opts.name}`);

        const reconnectInterval = 30000; // Intervalle de 30 secondes

        while (this.__status !== ResourceStatus.Connected && this.__status !== ResourceStatus.Closed) {
            console.log(`[ResourceHandler] Attempting periodic reconnection for resource: ${this.__opts.name}`);

            try {
                await this.__attemptReconnect();
            } catch (reconnectError) {
                console.error(`[ResourceHandler] Periodic reconnection failed for resource: ${this.__opts.name}. Retrying in ${reconnectInterval / 1000} seconds.`);
            }

            console.log(`[ResourceHandler] Waiting for ${reconnectInterval / 1000} seconds before next attempt.`);
            await this.__delay(reconnectInterval);
        }

        if (this.__status === ResourceStatus.Connected) {
            console.log(`[ResourceHandler] Resource is now connected: ${this.__opts.name}.`);
        } else if (this.__status === ResourceStatus.Closed) {
            console.log(`[ResourceHandler] Reconnection attempts stopped. Resource is closed.`);
        }
    }

    private async __attemptReconnect(): Promise<void> {
        if (this.__status !== ResourceStatus.Connected) {
            console.log(`[ResourceHandler] Reconnecting resource: ${this.__opts.name}`);
            await this.connect();
        }
    }

    private __delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private __setStatus(nextStatus: ResourceStatus): void {
        this.__status = nextStatus;

        process.nextTick(() => {
            this.emit('status', nextStatus);
        });
    }
}
