# Contributing to ContextAtlas

Thank you for your interest in contributing to ContextAtlas! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Bug Reports](#bug-reports)
- [Feature Requests](#feature-requests)
- [Pull Requests](#pull-requests)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Commit Messages](#commit-messages)
- [Documentation](#documentation)

## Bug Reports

Bug reports help us improve ContextAtlas. Please include:

- **ContextAtlas version**: Run `contextatlas --version` or check `package.json`
- **Node.js version**: Run `node --version`
- **Operating System**: Linux, macOS, or Windows
- **CLI or MCP mode**: Whether you're using the CLI or MCP server mode
- **Steps to reproduce**: Clear, numbered steps to reproduce the bug
- **Expected behavior**: What you expected to happen
- **Actual behavior**: What actually happened (include error messages if applicable)
- **Additional context**: Screenshots, logs, or any other relevant information

## Feature Requests

We welcome feature requests! Please provide:

- **Problem description**: What problem or use case does this feature address?
- **Proposed solution**: How do you envision this feature working?
- **Alternatives considered**: What alternative approaches did you consider?
- **Use case context**: How would this feature benefit users?

## Pull Requests

### PR Process

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** following our code style guidelines
3. **Test thoroughly** to ensure your changes work as expected
4. **Update documentation** if your changes affect user-facing behavior
5. **Submit a pull request** with a clear description of the changes

### PR Checklist

- [ ] Code builds successfully (`pnpm build`)
- [ ] Changes are tested locally
- [ ] Documentation is updated if needed
- [ ] Commit messages follow conventional commit format
- [ ] Changes are backward compatible (unless breaking)
- [ ] Related issues are referenced

### Development Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/codefromkarl/ContextAtlas.git
   cd ContextAtlas
   ```

2. **Install dependencies**:
   ```bash
   pnpm install
   ```

3. **Build the project**:
   ```bash
   pnpm build
   ```

4. **Run in development mode**:
   ```bash
   pnpm dev
   ```

5. **Run tests** (if available):
   ```bash
   pnpm test
   ```

## Code Style

We use [Biome](https://biomejs.dev/) for code formatting and linting. The project configuration is in `biome.json`.

- **Formatting**: Run `pnpm biome format` to format code
- **Linting**: Run `pnpm biome check` to check code style
- **Auto-fix**: Run `pnpm biome check --write` to auto-fix issues

### Code Style Guidelines

- Use TypeScript for type safety
- Follow the existing code structure and patterns
- Write clear, self-documenting code with comments when necessary
- Keep functions focused and modular
- Use meaningful variable and function names

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or changes
- `chore:` Build process or auxiliary tool changes

Examples:
- `feat: add support for multiple memory stores`
- `fix: resolve race condition in cache invalidation`
- `docs: update installation instructions`

## Documentation

For comprehensive documentation, please refer to the main [README.md](../README.md) and the [docs/](../docs/) directory.

When making changes that affect user-facing behavior:

1. Update the relevant documentation files
2. Ensure examples are accurate and up-to-date
3. Consider adding migration guides for breaking changes
4. Update the changelog if applicable

## Questions?

Feel free to open a discussion on [GitHub Discussions](https://github.com/codefromkarl/ContextAtlas/discussions) for questions or ideas that don't fit into a bug report or feature request.

---

Thank you for contributing to ContextAtlas! Your contributions help make this project better for everyone.
