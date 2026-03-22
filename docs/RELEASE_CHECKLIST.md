# Release Checklist

## Pre-Release Checks

- [ ] Run tests locally (`npm test`)
- [ ] Run build locally (`npm run build`)
- [ ] Version in `src/server.ts` (`SERVER_VERSION`) is updated
- [ ] Version in `package.json` is updated

## Release Steps

- [ ] Push all changes to the main branch
- [ ] Create a git tag for the version (e.g., `git tag v1.2.3`)
- [ ] Push the git tag (e.g., `git push origin v1.2.3`)
