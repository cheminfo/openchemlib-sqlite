# Changelog

## [2.0.0](https://github.com/cheminfo/openchemlib-sqlite/compare/v1.2.0...v2.0.0) (2026-06-03)


### ⚠ BREAKING CHANGES

* `MoleculesDBSQLite.search()` is now asynchronous and returns a `Promise<SearchResponse>`; callers must await it. New `MoleculesDBConfig` options `dbPath` and `poolSize` enable the worker pool, and a new `close()` method tears it down.

### Features

* default poolSize to 4 in SearchWorkerPoolOptions ([1f1b406](https://github.com/cheminfo/openchemlib-sqlite/commit/1f1b40650cc8bd30aeb57ab25e0a1e4281c06242))
* report substructure scan progress via an onProgress callback ([ac5f682](https://github.com/cheminfo/openchemlib-sqlite/commit/ac5f682309611ba8cffb4ff84e66321378475e82))
* run substructure search in a worker pool (async, multicore, progress) ([02db276](https://github.com/cheminfo/openchemlib-sqlite/commit/02db276df06a73f35b68c775d4dcb2fea6d0cd57))


### Bug Fixes

* skip 2D coordinate invention when parsing substructure candidates ([163bd44](https://github.com/cheminfo/openchemlib-sqlite/commit/163bd4416139e26a708b59edae646b72af0dc2d2))

## [1.2.0](https://github.com/cheminfo/openchemlib-sqlite/compare/v1.1.0...v1.2.0) (2026-05-18)


### Features

* add maxCandidates and maxResults early-exit options to substructure search ([7b21fdf](https://github.com/cheminfo/openchemlib-sqlite/commit/7b21fdf26c2d1fcd9db71ad1460c4c1d20d5637d))


### Bug Fixes

* return entryId as number instead of BigInt from rowToResult ([d5e74f7](https://github.com/cheminfo/openchemlib-sqlite/commit/d5e74f7a3a8ecafcf7bf13904ff06fab76585738))

## [1.1.0](https://github.com/cheminfo/openchemlib-sqlite/compare/v1.0.2...v1.1.0) (2026-05-14)


### Features

* empty-molecule optimization and mwColumn mass-difference sorting for substructure search ([d8cb9e5](https://github.com/cheminfo/openchemlib-sqlite/commit/d8cb9e5d6c4890ef518e74716ebe2bab10a8e536))

## [1.0.2](https://github.com/cheminfo/openchemlib-sqlite/compare/v1.0.1...v1.0.2) (2026-05-13)


### Bug Fixes

* correct NPM_TOKEN ([9424034](https://github.com/cheminfo/openchemlib-sqlite/commit/94240343113e0d115b9ee30d661ca39b0f650dc8))

## [1.0.1](https://github.com/cheminfo/openchemlib-sqlite/compare/v1.0.0...v1.0.1) (2026-05-13)


### Bug Fixes

* make insert idempotent with INSERT OR REPLACE ([475c4e9](https://github.com/cheminfo/openchemlib-sqlite/commit/475c4e98b6c4906801bade0cad77e3e10a175cf7))

## 1.0.0 (2026-05-13)


### Features

* initial implementation ([7edc0b0](https://github.com/cheminfo/openchemlib-sqlite/commit/7edc0b07540db5259cc961c75bd5b5a896e76b85))
