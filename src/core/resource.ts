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
    private reconnectTimer: NodeJS.Timeout | null = null;

    constructor(factory: ResourceFactory<T>, opts?: ResourceHandlerOptions<T>) {
        super();

        this.__opts = {
            name: opts?.name || 'Resource',
            closer: opts?.closer,
            eventBindings: opts?.eventBindings,
            retry: {
                retries: Infinity,
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
        await this.__connect();
    }

    public async close(): Promise<void> {
        if (this.__status === ResourceStatus.Closed) {
            return Promise.reject(new Error(`${this.__opts.name} is closed`));
        }

        if (this.__status === ResourceStatus.Connecting) {
            this.__setStatus(ResourceStatus.Closing);
            return Promise.resolve();
        }

        await this.__setToClose();
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
            this.__handleReconnect();
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
        if (this.isReconnecting || this.__status === ResourceStatus.Closing || this.__status === ResourceStatus.Closed) {
            console.log(`[ResourceHandler] Reconnection not possible for: ${this.__opts.name}`);
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
        this.__setStatus(ResourceStatus.Error);
        this.__startPeriodicReconnect();
    }

    private __connect(force: boolean = false): Promise<void> {
        if (!force) {
            if (
                this.__status === ResourceStatus.Connecting ||
                this.__status === ResourceStatus.Connected ||
                this.__status === ResourceStatus.Closing ||
                this.__status === ResourceStatus.Closed
            ) {
                return Promise.resolve();
            }
        }

        this.__setStatus(ResourceStatus.Connecting);
        this.__err = undefined;

        this.__resource = retry(
            () => {
                if (this.__status === ResourceStatus.Closing || this.__status === ResourceStatus.Closed) {
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
                if (this.__status === ResourceStatus.Closing || this.__status === ResourceStatus.Closed) {
                    this.__closeResource(res);
                    return Promise.reject(new Error(`${this.__opts.name} is closed`));
                }

                this.__subscribe(res);
                this.__setStatus(ResourceStatus.Connected);
                this.emit('open');
                return res;
            })
            .catch((err) => {
                if (!(err instanceof retry.AbortError)) {
                    this.__err = err;
                    this.__setStatus(ResourceStatus.Error);
                    this.emit('error', err);
                }
                return Promise.resolve(null);
            });

        return this.__resource.then(() => {});
    }

    private async __setToClose(): Promise<void> {
        console.log(`[ResourceHandler] Attempting to close resource: ${this.__opts.name}`);

        this.__setStatus(ResourceStatus.Closing);
        this.__stopPeriodicReconnect();

        try {
            const res = await this.__resource;
            if (res) {
                await this.__closeResource(res);
            }
        } catch (error) {
            console.error(`[ResourceHandler] Error while closing resource: ${error.message}`);
        }

        this.__setStatus(ResourceStatus.Closed);
        this.emit('close');
    }

    private async __closeResource(res: T): Promise<void> {
        res.removeAllListeners();
        if (this.__opts.closer) {
            await this.__opts.closer(res);
        } else {
            await res.close();
        }
    }

    private __startPeriodicReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        const attemptReconnect = () => {
            if (this.__status !== ResourceStatus.Connected && this.__status !== ResourceStatus.Closed) {
                console.log(`[ResourceHandler] Attempting periodic reconnection for resource: ${this.__opts.name}`);
                this.__connect(true)
                    .then(() => {
                        if (this.__status === ResourceStatus.Connected) {
                            console.log(`[ResourceHandler] Resource is now connected: ${this.__opts.name}`);
                            this.__stopPeriodicReconnect();
                        } else {
                            this.reconnectTimer = setTimeout(attemptReconnect, 30000);
                        }
                    })
                    .catch((error) => {
                        console.error(`[ResourceHandler] Periodic reconnection failed: ${error.message}`);
                        this.reconnectTimer = setTimeout(attemptReconnect, 30000);
                    });
            } else {
                this.__stopPeriodicReconnect();
            }
        };

        this.reconnectTimer = setTimeout(attemptReconnect, 30000);
    }

    private __stopPeriodicReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
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
