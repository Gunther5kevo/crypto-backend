export interface NormalizedMessage {
  source: 'bot' | 'userbot';
  text: string;
  author: string;
  timestamp: string;
  urls: string[];
  hashtags: string[];
  raw?: any;
}