# homehub

MCP (Model Context Protocol) server for homehub.

## Features

- [Add your features here]

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit the `.env` file with your configuration:

```env
PORT=3000
# Add your configuration variables here
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Health Check

```bash
curl http://localhost:3000/mcp/health
```

## Tools

### example-tool

[Describe your tool here]

## Prompts

### example-prompt

[Describe your prompt here]

## Resources

- **server-status**: Check server status

## Development

### Build

```bash
npm run build
```

### Run Tests

```bash
npm test
```

### Docker Build

```bash
# For ARM64 (Apple Silicon)
npm run build:docker:arm64

# For AMD64 (Intel/AMD)
npm run build:docker:amd64
```

## License

ISC

## Made with Bob
