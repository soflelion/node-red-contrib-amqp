import * as amqp from "amqplib";
import { NodeProperties } from 'node-red';

export interface NodeMessage {
    payload?: any;
    topic?: any;
    options?: amqp.Options.Publish;
    error?: Error;
}

export interface Properties extends NodeProperties {
    source: string;
    routingkey: string;
    iotype: string;
    ioname: string;
    server: string;
}
