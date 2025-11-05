import axios from 'axios';
import { createHash } from 'crypto';
import { Buffer } from 'buffer';

export function request(url, options, callback) {
    const { method = 'GET', headers = {}, body, form, follow_max = 5 } = options;

    const config = {
        url,
        method,
        headers,
        maxRedirects: follow_max,
        timeout: 15000,
    };

    if (body) {
        config.data = body;
    } else if (form) {
        config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        config.data = new URLSearchParams(form).toString();
    }

    axios(config)
        .then(response => {
            const resp = {
                statusCode: response.status,
                headers: response.headers,
                body: response.data,
            };
            callback(null, resp);
        })
        .catch(error => {
            console.error(`[Plugin Request Error] URL: ${url}`, error.message);
            callback(error, null);
        });
}

export const utils = {
    buffer: {
        from: (data, encoding) => Buffer.from(data, encoding),
        bufToString: (buffer, encoding) => buffer.toString(encoding),
    },
    crypto: {
        md5: (str) => createHash('md5').update(str).digest('hex'),
    },
};