# AI Dev Platform Example Projects

This directory contains example projects for testing and demonstrating the AI Dev Platform capabilities.

## Available Examples

### todo-app

A simple React + TypeScript todo application that demonstrates:

- Modern React patterns with hooks
- TypeScript integration
- Vite build tooling
- AI Dev Platform configuration

#### Running the Example

```bash
cd todo-app
npm install
npm run dev
```

#### Project Structure

```
todo-app/
├── ai-dev.json       # AI Dev Platform configuration
├── package.json      # Node.js project configuration
├── tsconfig.json     # TypeScript configuration
├── vite.config.ts    # Vite build configuration
├── index.html        # HTML entry point
└── src/
    ├── main.tsx      # Application entry point
    ├── App.tsx       # Main React component
    ├── App.css       # Component styles
    └── index.css     # Global styles
```

#### ai-dev.json Configuration

The `ai-dev.json` file configures the AI Dev Platform for this project:

```json
{
  "name": "todo-app-example",
  "version": "1.0.0",
  "description": "A simple todo app",
  "techStack": {
    "language": "typescript",
    "frontend": "react",
    "packageManager": "npm"
  },
  "codingStandards": {
    "indentStyle": "space",
    "indentSize": 2,
    "semi": true,
    "singleQuotes": true
  },
  "testFramework": "vitest",
  "hooks": {
    "preToolUse": [
      { "command": "echo 'Tool use blocked for safety'", "blocking": false }
    ]
  }
}
```

## Running E2E Tests

The platform includes an end-to-end test script that validates the complete workflow:

```bash
# From the project root
npx ts-node scripts/e2e-test.ts
```

The E2E test performs the following steps:

1. Verifies the example project exists
2. Installs dependencies
3. Runs TypeScript type checking
4. Builds the project

## Creating New Examples

When creating new example projects, follow these guidelines:

1. Create a new directory under `examples/`
2. Include an `ai-dev.json` configuration file
3. Provide a complete, working codebase
4. Document the example in this README

### Required Files

- `ai-dev.json` - Platform configuration
- `package.json` - Node.js dependencies and scripts
- Source code for a working application

### Recommended Structure

```
your-example/
├── ai-dev.json       # Required: Platform config
├── package.json      # Required: Dependencies
├── README.md         # Optional: Example-specific docs
└── src/              # Source code
```
