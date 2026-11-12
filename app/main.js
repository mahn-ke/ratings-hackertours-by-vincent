import http from 'http';

const PORT = 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200);
        res.end('OK');
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
