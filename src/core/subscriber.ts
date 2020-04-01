import * as amqp from 'amqplib';
import { Connection } from './connection';
import { ResourceEvent, ResourceHandler, ResourceStatus } from './resource';

export type SubscriberEvent = ResourceEvent | 'message';

export class Subscriber {
    private __handler: ResourceHandler<amqp.Channel>;
    private __queue: string;

    constructor(conn: Connection, queue: string) {
        this.__queue = queue;
        this.__handler = new ResourceHandler(async () => {
            const ch = await conn.createChannel();
            await ch.consume(
                this.__queue,
                (msg: amqp.ConsumeMessage | null) => {
                    if (msg) {
                        this.__handler.emit('message', msg);
                    }
                },
                {
                    noAck: true,
                },
            );

            return ch;
        });
    }

    public get queue(): string {
        return this.__queue;
    }

    public get status(): ResourceStatus {
        return this.__handler.status;
    }

    public async ready(): Promise<void> {
        await this.__handler.resource;
    }

    public async close(): Promise<void> {
        this.__handler.close();
    }

    public on(event: SubscriberEvent, handler: any): void {
        this.__handler.on(event, handler);
    }

    public once(event: SubscriberEvent, handler: any): void {
        this.__handler.on(event, handler);
    }

    public off(event: string, handler: any): void {
        this.__handler.off(event, handler);
    }
}
