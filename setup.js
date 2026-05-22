import webpush from 'web-push';
import fs from 'fs';

const vapidKeys = webpush.generateVAPIDKeys();

let env = '';
try { env = fs.readFileSync('.env', 'utf8'); } catch {}

const set = (content, key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return re.test(content) ? content.replace(re, line) : content + `\n${line}`;
};

env = set(env, 'VAPID_PUBLIC_KEY', vapidKeys.publicKey);
env = set(env, 'VAPID_PRIVATE_KEY', vapidKeys.privateKey);
fs.writeFileSync('.env', env.trim() + '\n');

console.log('VAPID keys generated and saved to .env');
console.log('Public key:', vapidKeys.publicKey);
