module.exports = {
  apps: [{
    name: 'heimdall',
    script: 'index.js',
    cwd: '/home/ubuntu/heimdall',
    env: {
      NODE_OPTIONS: '--max-old-space-size=192',
    },
    max_restarts: 20,
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    max_memory_restart: '180M',
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    out_file: '/home/ubuntu/heimdall/logs/out.log',
    error_file: '/home/ubuntu/heimdall/logs/err.log',
    merge_logs: true,
    kill_timeout: 5000,
  },
  {
    name: 'heimdall-webui',
    script: 'webui-sim.js',
    cwd: '/home/ubuntu/heimdall',
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
