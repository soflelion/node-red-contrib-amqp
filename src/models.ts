import { NodeProperties } from 'node-red';

export interface NodeMessage {
    payload?: any;
    topic?: any;
}

export interface Properties extends NodeProperties {
    source: string;
    routingkey: string;
    iotype: string;
    ioname: string;
    server: string;
}
