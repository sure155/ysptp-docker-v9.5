// CF Worker proxy script for ysp-live-lite
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const token = url.pathname.split('/')[1];
  const targetUrl = `http://your-vps-ip:8767/${token}${url.pathname.replace(`/${token}`, '')}${url.search}`; // Replace your-vps-ip
  const newRequest = new Request(targetUrl, request);
  return fetch(newRequest);
}
