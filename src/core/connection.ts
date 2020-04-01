import * as amqp from 'amqplib';
import url from 'url';
import { ResourceEvent, ResourceHandler, ResourceStatus } from './resource';
import { ConnectionSettings } from './settings';
import { cert } from './tls';

export type ConnectionEvent = ResourceEvent | 'blocked' | 'unblocked';

async function openInternal(
    settings: ConnectionSettings,
): Promise<amqp.Connection> {
    const u = url.parse(`${settings.host}:${settings.port}`);

    const protocol = settings.useTLS ? 'amqps' : 'amqp';
    let socketOpts;

    if (settings.useTLS) {
        const ca = cert(settings.useCA ? settings.ca : undefined);

        socketOpts = {
            ca: [ca],
        };
    }

    return await amqp.connect(
        {
            protocol,
            vhost: settings.vhost,
            username: settings.username,
            password: settings.password,
            hostname: u.hostname || 'localhost',
            port: u.port ? parseFloat(u.port) : 5672,
            heartbeat: settings.keepAlive,
            frameMax: 0,
        },
        socketOpts,
    );
}

export class Connection {
    private __conn: ResourceHandler<amqp.Connection>;
    private __settings: ConnectionSettings;

    constructor(settings: ConnectionSettings) {
        this.__settings = settings;
        this.__conn = new ResourceHandler(() => openInternal(this.__settings), {
            name: 'Connection',
        });
    }

    public get status(): ResourceStatus {
        return this.__conn.status;
    }

    public async close(): Promise<void> {
        return this.__conn.close();
    }

    public async createChannel(): Promise<amqp.Channel> {
        const conn = await this.__conn.resource;

        return conn.createChannel();
    }

    public async ready(): Promise<void> {
        await this.__conn.resource;
    }

    public on(event: ConnectionEvent, handler: any): void {
        this.__conn.on(event, handler);
    }

    public once(event: ConnectionEvent, handler: any): void {
        this.__conn.once(event, handler);
    }

    public off(event: ConnectionEvent, handler: any): void {
        this.__conn.off(event, handler);
    }
}
