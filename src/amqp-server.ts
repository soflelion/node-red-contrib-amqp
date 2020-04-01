import { Node, NodeProperties, Red } from 'node-red';
import {
    ConnectionSettings,
    ResourceRetryError,
    ResourceStatus,
    close,
    open,
} from './core';

export interface ServerNode extends Node {
    settings: ConnectionSettings;
    credentials: {
        user?: string;
        password?: string;
    };
}

interface Properties extends NodeProperties {
    host: string;
    port: number;
    vhost: string;
    keepalive: number;
    usetls: boolean;
    verifyservercert: boolean;
    useca: boolean;
    ca: string;
    usetopology: boolean;
    topology: string;
}

module.exports = function register(RED: Red): void {
    RED.nodes.registerType(
        'amqp-server',
        function AmqpServerConfig(this: ServerNode, props: Properties): void {
            RED.nodes.createNode(this, props);

            this.settings = {
                vhost: props.vhost,
                host: props.host,
                port: props.port,
                keepAlive: props.keepalive,
                verifyServerCert: props.verifyservercert,
                ca: props.ca,
                topology: props.topology,
                useCA: props.useca,
                useTLS: props.usetls,
                useTopology: props.usetopology,
                username: this.credentials.user || '',
                password: this.credentials.password || '',
            };

            const conn = open(this.settings);

            conn.on('status', (status: ResourceStatus) => {
                this.log(`[AMQP] Connection status: ${status}`);
            });

            conn.on('retry', (retry: ResourceRetryError) => {
                this.log(`[AMQP] Connection error: ${retry.message}`);
                this.log(
                    `[AMQP] Attempt ${retry.attemptNumber} failed. There are ${retry.retriesLeft} retries left.`,
                );
            });

            this.on('close', (done: Function) => {
                close(this.settings).finally(() => done());
            });
        },
        {
            credentials: {
                username: { type: 'text' },
                password: { type: 'password' },
            },
        },
    );
};
