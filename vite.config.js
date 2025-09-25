import { resolve } from 'path';

export default {
    base: '/paste-utility/',
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
