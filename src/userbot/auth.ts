import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (text: string): Promise<string> =>
  new Promise(resolve => rl.question(text, resolve));

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID!);
  const apiHash = process.env.TELEGRAM_API_HASH!;

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await question('Enter your phone number (+254...): '),
    password: async () => await question('Enter 2FA password (or press Enter): '),
    phoneCode: async () => await question('Enter the code Telegram sent you: '),
    onError: (err) => console.error('[auth] Error:', err),
  });

  const sessionString = client.session.save() as unknown as string;

  console.log('\n✅ Authentication successful!');
  console.log('\nCopy this session string into your .env as TELEGRAM_SESSION:\n');
  console.log(sessionString);
  console.log('\n');

  rl.close();
  await client.disconnect();
}

main().catch(console.error);