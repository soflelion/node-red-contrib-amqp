import { Node } from 'node-red';
import { ResourceStatus } from './core';

export function setStatus(node: Node, status: ResourceStatus): void {
    switch (status) {
        case ResourceStatus.Connected: {
            node.status({
                fill: 'green',
                shape: 'dot',
                text: 'connected',
            });

            break;
        }
        case ResourceStatus.Connecting: {
            node.status({
                fill: 'yellow',
                shape: 'ring',
                text: 'connecting',
            });

            break;
        }
        case ResourceStatus.Error: {
            node.status({
                fill: 'red',
                shape: 'dot',
                text: 'error',
            });

            break;
        }
        default: {
            node.status({
                fill: 'red',
                shape: 'dot',
                text: status.toString(),
            });

            break;
        }
    }
}
