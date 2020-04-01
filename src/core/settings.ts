export interface ConnectionSettings {
    host: string;
    port: number;
    vhost: string;
    keepAlive: number;
    useTLS: boolean;
    verifyServerCert: boolean;
    useCA: boolean;
    ca: string;
    useTopology: boolean;
    topology: string;
    username: string;
    password: string;
}
