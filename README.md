# Node-RED AMQP input and output nodes

`node-red-contrib-amqp` is a [Node-RED](http://nodered.org/docs/creating-nodes/packaging.html) package that connects directly to an AMQP server (e.g. [RabbitMQ](https://www.rabbitmq.com/)). It contains an input, an output and a configuration node to connect to AMQP exchanges or queues for Node-RED.

## Table of Contents

-   [Installation](#installation)
-   [Overview](#overview)

## Installation <a name="installation"></a>

If you have installed Node-RED as a global node.js package (you use the command `node-red` anywhere to start it), you need to install
`node-red-contrib-amqp` as a global package as well:

```
$[sudo] npm install -g @node-red-tools/node-red-contrib-amqp
```

If you have installed the .zip or cloned your own copy of Node-RED from github, you can install it as a normal npm package inside the Node-RED project directory:

```
<path/to/node-red>$ npm install @node-red-tools/node-red-contrib-amqp
```

## Overview <a name="overview"></a>

The package contains the following Node-RED nodes:

### input: amqp

Subscribes to an AMQP exchange or queue and reads messages from it. It outputs an object called
`msg` containing the following fields:

-   `msg.payload` is a string or an object containing the content of the AMQP message.
-   `msg.topic` is a string containing the routing-key of the AMQP message.

If a topic is defined in the input node definition, that will be sent as `msg.topic` instead of the routing key.

In the settings you can only define the exchange type or queue and it's name.

### output: amqp

Delivers incoming the message payload to the specified exchange or queue. It expects an object called
`msg` containing the following fields:

-   `msg.payload`: string or an object containing the content of the AMQP message to be sent.
-   `msg.topic`: string containing the routing-key of the AMQP message to be sent.
-   `msg.options`: object containing specific AMQP properties for the message to be sent, see the
    [amqplib publish](http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish) documentation for more information.

If a topic is defined in the output node definition, that will be sent as routing-key instead of the `msg.topic`. If the `msg.payload` field does not exist, the whole msg object will be sent.

In the settings you can only define the exchange type or queue and it's name.

### configuration: amqp-server

Defines the connection to the AMQP server.
