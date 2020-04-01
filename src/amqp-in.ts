import * as amqp from 'amqplib';
import { Node, Red } from 'node-red';
import { ServerNode } from './amqp-server';
import { ResourceStatus, Subscriber, open } from './core';
import { setStatus } from './helpers';
import { Properties } from './models';

interface AmqpInNode extends Node {}

module.exports = function register(RED: Red): void {
    RED.nodes.registerType('amqp in', function AmqpIn(
        this: AmqpInNode,
        props: Properties,
    ): void {
        RED.nodes.createNode(this, props);

        setStatus(this, ResourceStatus.Connecting);

        const config = RED.nodes.getNode(props.server) as ServerNode;

        if (!config) {
            setStatus(this, ResourceStatus.Error);
            this.error('Node is not configured');

            return;
        }

        const sub = new Subscriber(open(config.settings), props.ioname);

        setStatus(this, sub.status);

        sub.on('status', (status: ResourceStatus) => setStatus(this, status));
        sub.on('error', (err: Error) =>
            this.error(err.toString(), { error: err }),
        );
        sub.on('message', (msg: amqp.ConsumeMessage) => {
            this.send({
                topic: props.routingkey || msg.fields.routingKey,
                payload: msg.content.toString('utf8'),
            });
        });

        this.on('close', async () => {
            try {
                await sub.close();
            } catch (e) {
                this.error(e.message, { error: e });
            }
        });
    });
};
