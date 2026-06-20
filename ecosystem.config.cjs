module.exports = {
  apps: [{
    name: 'indikratos',
    script: 'index.js',
    cwd: '/home/ubuntu/indikratos',
    env: {
      NODE_OPTIONS: '--max-old-space-size=192',
    },
    max_restarts: 20,
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: '180M',
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    out_file: '/home/ubuntu/indikratos/logs/out.log',
    error_file: '/home/ubuntu/indikratos/logs/err.log',
    merge_logs: true,
    kill_timeout: 5000,
  },
  {
    name: 'indikratos-webui',
    script: 'webui-sim.js',
    cwd: '/home/ubuntu/indikratos',
    env: {
      NODE_OPTIONS: '--max-old-space-size=192',
    },
    max_restarts: 20,
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: '180M',
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    kill_timeout: 5000,
  }]
};
