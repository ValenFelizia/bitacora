import type { serve } from '../src/server';
export async function authenticate(server: Awaited<ReturnType<typeof serve>>) {
  const url = new URL(server.entryUrl);
  const response = await fetch(`http://127.0.0.1:${server.port}/entry`, {
    method:'POST', headers:{Origin:url.origin}, body:url.hash.slice(1),
  });
  if(response.status !== 204) throw Error('Entry rejected');
  return response.headers.get('set-cookie')!.split(';')[0];
}
