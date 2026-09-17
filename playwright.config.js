import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'./tests-browser',timeout:30000,fullyParallel:false,workers:1,retries:0,
  reporter:'list',use:{headless:true,trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}]});
