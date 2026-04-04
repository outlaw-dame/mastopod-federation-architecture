import { fetch } from 'undici';

const API = 'https://safebrowsing.googleapis.com/v5alpha1/urls:search';

export async function checkUrlsSafe(urls: string[], apiKey: string) {
  const query = new URLSearchParams();
  urls.forEach(u => query.append('urls', u));

  const res = await fetch(`${API}?${query.toString()}&key=${apiKey}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SafeBrowsing error: ${text}`);
  }

  const data = await res.json();

  return {
    threats: data.threats || [],
    cacheDuration: data.cacheDuration
  };
}
