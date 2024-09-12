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
        this.__resource = undefined as any; // TS hack. We set in __connect
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
            return Promise.reject(new Error(`${this.__opts} is not available`));
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
            this.__connect();

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
            // Tentative de reconnexion avant la fermeture
            console.log(`[ResourceHandler] Attempting to reconnect before closing: ${this.__opts.name}`);
            await this.__attemptReconnect(); // Nouvelle méthode pour tenter la reconnexion
            console.log(`[ResourceHandler] Reconnection successful: ${this.__opts.name}`);
            this.__setStatus(ResourceStatus.Connected);
            return;
        } catch (reconnectError) {
            // Si la reconnexion échoue, marquer la ressource comme fermée
            console.error(`[ResourceHandler] Failed to reconnect: ${reconnectError.message}`);
            this.__resource = Promise.reject(new Error(`${this.__opts.name} is closed`));
            this.__err = undefined;
            this.__setStatus(ResourceStatus.Closed);
            this.emit('close');
            this.removeAllListeners();
        }
    }
    

    private async __attemptReconnect(): Promise<void> {
        if (this.__status !== ResourceStatus.Connected) {
            console.log(`[ResourceHandler] Reconnecting resource: ${this.__opts.name}`);
            await this.connect(); // Assurez-vous que la méthode `connect` tente de recréer la connexion/canal
        }
    }
    

    private __setStatus(nextStatus: ResourceStatus): void {
        this.__status = nextStatus;

        process.nextTick(() => {
            this.emit('status', nextStatus);
        });
    }
}
