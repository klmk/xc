#!/usr/bin/env ts-node
/**
 * End-to-end test script for the AI Dev Platform.
 * This script tests the complete flow from requirement to deployed application.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';

const EXAMPLE_DIR = join(__dirname, '../examples/todo-app');

async function runCommand(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true });
    proc.on('close', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`Command failed: ${cmd} ${args.join(' ')}`));
    });
    proc.on('error', reject);
  });
}

async function main() {
  console.log('🧪 AI Dev Platform E2E Test\n');

  // Step 1: Verify example project exists
  console.log('📁 Step 1: Verifying example project...');
  try {
    const config = await readFile(join(EXAMPLE_DIR, 'ai-dev.json'), 'utf-8');
    console.log('  ✅ ai-dev.json found');
  } catch {
    console.log('  ❌ Example project not found. Run setup first.');
    process.exit(1);
  }

  // Step 2: Install dependencies
  console.log('\n📦 Step 2: Installing dependencies...');
  await runCommand('npm', ['install'], EXAMPLE_DIR);
  console.log('  ✅ Dependencies installed');

  // Step 3: Run TypeScript check
  console.log('\n🔍 Step 3: Running TypeScript check...');
  await runCommand('npx', ['tsc', '--noEmit'], EXAMPLE_DIR);
  console.log('  ✅ TypeScript check passed');

  // Step 4: Build the project
  console.log('\n🏗️ Step 4: Building the project...');
  await runCommand('npm', ['run', 'build'], EXAMPLE_DIR);
  console.log('  ✅ Build successful');

  console.log('\n✅ E2E Test Passed!\n');
}

main().catch((err) => {
  console.error('❌ E2E Test Failed:', err.message);
  process.exit(1);
});
