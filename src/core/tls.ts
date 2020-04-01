import fs, { readFileSync } from 'fs';

const DEFAULT_CA_LOCATION = '/etc/ssl/certs/ca-certificates.crt';

function readFileAsync(filepath: string): Promise<any> {
    return new Promise((resolve, reject) => {
        fs.readFile(
            filepath,
            (err: NodeJS.ErrnoException | null, result: any) => {
                if (err != null) {
                    reject(err);

                    return;
                }

                resolve(result);
            },
        );
    });
}

export async function cert(filepath?: string): Promise<Buffer> {
    if (filepath) {
        return readFileAsync(filepath);
    }

    return readFileSync(DEFAULT_CA_LOCATION);
}
