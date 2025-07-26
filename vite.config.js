export default {
    base: './',
    optimizeDeps: { exclude: ["fsevents"] },
    publicDir: 'public',
    build: {
        rollupOptions: {
          input: {
            main: resolve(__dirname, 'index.html'),
            help: resolve(__dirname, 'help.html')
          }
        }
      }
}