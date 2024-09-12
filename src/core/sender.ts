import * as amqp from 'amqplib';
import { Connection } from './connection';
import { ResourceEvent, ResourceHandler, ResourceStatus } from './resource';

export type SenderEvent = ResourceEvent;

export class Sender {
    private __handler: ResourceHandler<amqp.Channel>;
    private __exchange: string;

    constructor(conn: Connection, exchange: string) {
        this.__handler = new ResourceHandler(() => conn.createChannel(), {
            name: 'Sender',
            closer: async (ch: amqp.Channel) => {
                // if connection is not being closed
                // we can safely close the channel
                if (conn.status === ResourceStatus.Connected) {
                    return ch.close();
                }

                // otherwise, we ignore expplicit closure
                return Promise.resolve();
            },
        });
        this.__exchange = exchange;
    }

    public get exchange(): string {
        return this.__exchange;
    }

    public async send(
        topic: string,
        payload: any,
        options?: amqp.Options.Publish,
    ): Promise<boolean> {
        const ch = await this.__handler.resource();

        return ch.publish(
            this.__exchange,
            topic,
            Buffer.from(JSON.stringify(payload), 'utf8'),
            options,
        );
    }

    public get status(): ResourceStatus {
        return this.__handler.status;
    }

    public async ready(): Promise<void> {
        await this.__handler.resource();
    }

    public async close(): Promise<void> {
        this.__handler.close();
    }

    public on(event: SenderEvent, handler: any): void {
        this.__handler.on(event, handler);
    }

    public once(event: SenderEvent, handler: any): void {
        this.__handler.on(event, handler);
    }

    public off(event: SenderEvent, handler: any): void {
        this.__handler.off(event, handler);
    }
}
