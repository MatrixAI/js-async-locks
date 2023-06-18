# js-async-locks

staging:[![pipeline status](https://gitlab.com/MatrixAI/open-source/js-async-locks/badges/staging/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-async-locks/commits/staging)
master:[![pipeline status](https://gitlab.com/MatrixAI/open-source/js-async-locks/badges/master/pipeline.svg)](https://gitlab.com/MatrixAI/open-source/js-async-locks/commits/master)

Asynchronous lock utilities.

JavaScript exposes the ability to create interleaved execution of asynchronous
operations. When this is done with shared state between asynchronous
overlapping functions that perform partial state transitions, this can lead to
race conditions or data corruption and clobbering, or just invalid pre-condition
or post-condition behaviour.

This library provides multiple synchronization constructs that allow one to
precisely control concurrent operations. These constructs are intended for
pessimistic concurrency control. If you can prefer to use optimistic concurrency
control mechanisms. But that is outside the scope of this library. In many cases
you cannot use optimistic methods, and thus you need this library.

## Installation

```sh
npm install --save @matrixai/async-locks
```

## Development

Run `nix-shell`, and once you're inside, you can use:

```sh
# install (or reinstall packages from package.json)
npm install
# build the dist
npm run build
# run the repl (this allows you to import from ./src)
npm run ts-node
# run the tests
npm run test
# lint the source code
npm run lint
# automatically fix the source
npm run lintfix
```

### Docs Generation

```sh
npm run docs
```

See the docs at: https://matrixai.github.io/js-async-locks/

### Publishing

Publishing is handled automatically by the staging pipeline.

Prerelease:

```sh
# npm login
npm version prepatch --preid alpha # premajor/preminor/prepatch
git push --follow-tags
```

Release:

```sh
# npm login
npm version patch # major/minor/patch
git push --follow-tags
```

Manually:

```sh
# npm login
npm version patch # major/minor/patch
npm run build
npm publish --access public
git push
git push --tags
```
