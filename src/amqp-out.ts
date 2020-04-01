import { Node, Red } from 'node-red';
import { ServerNode } from './amqp-server';
import { ResourceStatus, Sender, open } from './core';
import { setStatus } from './helpers';
import { NodeMessage, Properties } from './models';

interface AmqpOutNode extends Node {}

module.exports = function register(RED: Red): void {
    RED.nodes.registerType('amqp out', function AmqpOut(
        this: AmqpOutNode,
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

        const sender = new Sender(open(config.settings), props.ioname);
        setStatus(this, ResourceStatus.Connected);

        sender.on('status', (status: ResourceStatus) =>
            setStatus(this, status),
        );
        sender.on('error', (err: Error) =>
            this.error(err.toString(), { error: err }),
        );

        this.on('input', async (msg: NodeMessage) => {
            try {
                await sender.send(props.routingkey || msg.topic, msg.payload, msg.options);
            } catch (e) {
                msg.error = e;

                this.error(e.message, msg);
            }
        });

        this.on('close', async () => {
            try {
                await sender.close();
            } catch (e) {
                this.error(e.message, { error: e });
            }
        });
    });
};
