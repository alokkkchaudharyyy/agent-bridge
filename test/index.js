// Forwarder for `node --test test/` directory resolution in Node 22+
if (!process.argv[1] || !process.argv[1].endsWith('index.js')) {
  require('./core.test.js');
}
