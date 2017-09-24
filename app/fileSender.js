import Nanobus from 'nanobus';
import { arrayToB64, b64ToArray, bytes } from './utils';

export default class FileSender extends Nanobus {
  constructor(file) {
    super('FileSender');
    this.file = file;
    this.msg = 'importingFile';
    this.progress = [0, 1];
    this.cancelled = false;
    this.iv = window.crypto.getRandomValues(new Uint8Array(12));
    this.uploadXHR = new XMLHttpRequest();
    this.rawSecret = window.crypto.getRandomValues(new Uint8Array(16));
    this.secretKey = window.crypto.subtle.importKey(
      'raw',
      this.rawSecret,
      'HKDF',
      false,
      ['deriveKey']
    );
  }

  static delete(id, token) {
    return new Promise((resolve, reject) => {
      if (!id || !token) {
        return reject();
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/delete/${id}`);
      xhr.setRequestHeader('Content-Type', 'application/json');

      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          resolve();
        }
      };

      xhr.send(JSON.stringify({ delete_token: token }));
    });
  }

  get progressRatio() {
    return this.progress[0] / this.progress[1];
  }

  get sizes() {
    return {
      partialSize: bytes(this.progress[0]),
      totalSize: bytes(this.progress[1])
    };
  }

  cancel() {
    this.cancelled = true;
    if (this.msg === 'fileSizeProgress') {
      this.uploadXHR.abort();
    }
  }

  readFile() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsArrayBuffer(this.file);
      reader.onload = function(event) {
        const plaintext = new Uint8Array(this.result);
        resolve(plaintext);
      };
      reader.onerror = function(err) {
        reject(err);
      };
    });
  }

  uploadFile(encrypted, metadata, rawAuth) {
    return new Promise((resolve, reject) => {
      const dataView = new DataView(encrypted);
      const blob = new Blob([dataView], { type: 'application/octet-stream' });
      const fd = new FormData();
      fd.append('data', blob);

      const xhr = this.uploadXHR;

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          this.progress = [e.loaded, e.total];
          this.emit('progress', this.progress);
        }
      });

      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          if (xhr.status === 200) {
            this.progress = [1, 1];
            this.msg = 'notifyUploadDone';
            const responseObj = JSON.parse(xhr.responseText);
            return resolve({
              url: responseObj.url,
              id: responseObj.id,
              secretKey: arrayToB64(this.rawSecret),
              deleteToken: responseObj.delete,
              challenge: responseObj.challenge
            });
          }
          this.msg = 'errorPageHeader';
          reject(new Error(xhr.status));
        }
      };

      xhr.open('post', '/api/upload', true);
      xhr.setRequestHeader(
        'X-File-Metadata',
        arrayToB64(new Uint8Array(metadata))
      );
      xhr.setRequestHeader('Authorization', `send-v1 ${arrayToB64(rawAuth)}`);
      xhr.send(fd);
      this.msg = 'fileSizeProgress';
    });
  }

  async upload() {
    const encoder = new TextEncoder();
    const secretKey = await this.secretKey;
    const encryptKey = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        salt: new Uint8Array(),
        info: encoder.encode('encryption'),
        hash: 'SHA-256'
      },
      secretKey,
      {
        name: 'AES-GCM',
        length: 128
      },
      false,
      ['encrypt']
    );
    const authKey = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        salt: new Uint8Array(),
        info: encoder.encode('authentication'),
        hash: 'SHA-256'
      },
      secretKey,
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      true,
      ['sign']
    );
    const metaKey = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        salt: new Uint8Array(),
        info: encoder.encode('metadata'),
        hash: 'SHA-256'
      },
      secretKey,
      {
        name: 'AES-GCM',
        length: 128
      },
      false,
      ['encrypt']
    );
    const plaintext = await this.readFile();
    if (this.cancelled) {
      throw new Error(0);
    }
    this.msg = 'encryptingFile';
    this.emit('encrypting');
    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: this.iv,
        tagLength: 128
      },
      encryptKey,
      plaintext
    );
    const metadata = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(12),
        tagLength: 128
      },
      metaKey,
      encoder.encode(
        JSON.stringify({
          iv: arrayToB64(this.iv),
          name: this.file.name,
          type: this.file.type
        })
      )
    );
    const rawAuth = await window.crypto.subtle.exportKey('raw', authKey);
    if (this.cancelled) {
      throw new Error(0);
    }
    return this.uploadFile(encrypted, metadata, new Uint8Array(rawAuth));
  }

  static async setPassword(password, file) {
    const encoder = new TextEncoder();
    const secretKey = await window.crypto.subtle.importKey(
      'raw',
      b64ToArray(file.secretKey),
      'HKDF',
      false,
      ['deriveKey']
    );
    const authKey = await window.crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        salt: new Uint8Array(),
        info: encoder.encode('authentication'),
        hash: 'SHA-256'
      },
      secretKey,
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      true,
      ['sign']
    );
    const sig = await window.crypto.subtle.sign(
      {
        name: 'HMAC'
      },
      authKey,
      b64ToArray(file.challenge) // TODO + url
    );
    console.log(password + file.url);
    const pwdKey = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(password + file.url),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );
    const newAuthKey = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: b64ToArray(
          'MbQHl8yVrGWuAe3q2ltMQHgvnetDgOvPHEZeGKqc3s7MFQLPiJuMn10UtQTL1pjhPJj5Cl1i7goYtXLcJGc9og'
        ), //TODO
        iterations: 100,
        hash: 'SHA-256'
      },
      pwdKey,
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      true,
      ['sign']
    );
    const rawAuth = await window.crypto.subtle.exportKey('raw', newAuthKey);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onreadystatechange = () => {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          if (xhr.status === 200) {
            return resolve(xhr.response);
          }
          if (xhr.status === 401) {
            const challenge = xhr
              .getResponseHeader('WWW-Authenticate')
              .split(' ')[1];
            file.challenge = challenge;
          }
          reject(new Error(xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error(0));
      xhr.ontimeout = () => reject(new Error(0));
      xhr.open('post', `/api/password/${file.id}`);
      xhr.setRequestHeader(
        'Authorization',
        `send-v1 ${arrayToB64(new Uint8Array(sig))}`
      );
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.responseType = 'json';
      xhr.timeout = 2000;
      xhr.send(JSON.stringify({ auth: arrayToB64(new Uint8Array(rawAuth)) }));
    });
  }
}
