import * as events from 'events';
import retry, { FailedAttemptError } from 'p-retry';
import { TimeoutsOptions } from 'retry';
import { setTimeout } from 'timers';

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
    private isReconnecting: boolean = false; // Drapeau pour éviter les reconnexions simultanées
    private reconnectAttempts: number = 0; // Compteur pour les tentatives de reconnexion
    private readonly maxReconnectAttempts: number = 5; // Nombre maximum de tentatives
    private readonly reconnectDelay: number = 5000; // Délai entre les tentatives

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
            this.__handleReconnect(); // Gestion des erreurs avec reconnexion
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

    // Gérer la reconnexion avec délai et nombre maximum de tentatives
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

            await this.__delay(this.reconnectDelay); // Attente entre les tentatives

            try {
                await this.__connect(true); // Tentative de reconnexion
                console.log(`[ResourceHandler] Reconnection successful after ${this.reconnectAttempts} attempts for: ${this.__opts.name}`);
                this.isReconnecting = false;
                return; // Succès, arrêt des tentatives
            } catch (error) {
                console.error(`[ResourceHandler] Reconnection attempt ${this.reconnectAttempts} failed: ${error.message}`);
            }
        }

        // Si toutes les tentatives échouent, fermeture de la ressource
        console.error(`[ResourceHandler] Max reconnection attempts reached for: ${this.__opts.name}`);
        this.isReconnecting = false;
        this.__setToClose(); // Ferme la ressource
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
            // Si une reconnexion est en cours, attendre la fin du processus avant de fermer
            if (this.isReconnecting) {
                console.log(`[ResourceHandler] Reconnection in progress, delaying closure for: ${this.__opts.name}`);
                return;
            }
    
            // Tentative de reconnexion avant de fermer la ressource
            console.log(`[ResourceHandler] Attempting to reconnect before closing: ${this.__opts.name}`);
            await this.__attemptReconnect(); // Tente une reconnexion
    
            // Si la reconnexion réussit, ne pas fermer la ressource
            if (this.__status === ResourceStatus.Connected) {
                console.log(`[ResourceHandler] Reconnection successful, resource will not be closed: ${this.__opts.name}`);
                return;
            }
    
        } catch (reconnectError) {
            // Si la reconnexion échoue, on log l'erreur
            console.error(`[ResourceHandler] Failed to reconnect: ${reconnectError.message}`);
    
            // Mise en place de la reconnexion périodique
            this.__startPeriodicReconnect(); // Lancer la reconnexion périodique si la reconnexion échoue
        }
    
        // Si la reconnexion échoue ou si la ressource doit être fermée, on procède à la fermeture propre
        console.log(`[ResourceHandler] Closing resource: ${this.__opts.name}`);
        this.__resource = Promise.reject(new Error(`${this.__opts.name} is closed`));
        this.__err = undefined;
        this.__setStatus(ResourceStatus.Closed);
        this.emit('close');
        this.removeAllListeners();
    }
    
// Lancer la reconnexion périodique avec un délai de 30 secondes entre les tentatives
private async __startPeriodicReconnect(): Promise<void> {
    console.log(`[ResourceHandler] Starting periodic reconnection for resource: ${this.__opts.name}`);
    
    const reconnectInterval = 30000; // Intervalle de 30 secondes entre chaque tentative de reconnexion

    // Boucle de reconnexion qui s'arrête quand la ressource est connectée ou fermée
    while (this.__status !== ResourceStatus.Closed) {
        // Vérifier si la ressource est connectée
        if (this.__status === ResourceStatus.Connected) {
            console.log(`[ResourceHandler] Resource is already connected: ${this.__opts.name}. No further reconnection needed.`);
            return; // Sortie de la boucle si la ressource est connectée
        }

        // Tentative de reconnexion si la ressource n'est pas connectée ni fermée
        console.log(`[ResourceHandler] Attempting periodic reconnection for resource: ${this.__opts.name}`);
        try {
            await this.__attemptReconnect(); // Tentative de reconnexion
        } catch (reconnectError) {
            console.error(`[ResourceHandler] Periodic reconnection failed for resource: ${this.__opts.name}. Retrying in ${reconnectInterval / 1000} seconds.`);
        }

        // Attendre avant la prochaine tentative de reconnexion
        await this.__delay(reconnectInterval);
    }

    // Si la boucle se termine parce que la ressource est fermée
    console.log(`[ResourceHandler] Reconnection attempts stopped. Resource is closed.`);
}

 
    

    private async __attemptReconnect(): Promise<void> {
        if (this.__status !== ResourceStatus.Connected) {
            console.log(`[ResourceHandler] Reconnecting resource: ${this.__opts.name}`);
            await this.connect(); // Tente de recréer la connexion
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
