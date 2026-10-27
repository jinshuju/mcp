# Changelog

## [0.5.0](https://github.com/jinshuju/mcp/compare/v0.4.0...v0.5.0) (2026-10-27)


### Features

* add the prepare_*_upload tools for uploading local files ([6afec7a](https://github.com/jinshuju/mcp/commit/6afec7abe3ddbf05704b8d4b3a96bb827db07ff9))


### Fixes

* keep exam and evaluation question types out of create_form ([d3b5686](https://github.com/jinshuju/mcp/commit/d3b5686f43f0dccdb20e39d638c8f60dd1e5b60a))

## [0.4.0](https://github.com/jinshuju/mcp/compare/v0.3.0...v0.4.0) (2026-10-23)


### Features

* add the delete_form tool ([6b08c64](https://github.com/jinshuju/mcp/commit/6b08c643eb1100f2b5179d3d670cc4ab1b5f6811))


### Fixes

* identify OAuth users whose token lacks the users scope ([5d73527](https://github.com/jinshuju/mcp/commit/5d73527024cfc5eef11990299e92d8bffddd1d54))
* point get_schema misses at the right schema or tool ([3a2e9a9](https://github.com/jinshuju/mcp/commit/3a2e9a97582ecb5a729c2ce6f610df9514dc3a99))
* take fields and form_tokens as arrays ([538d2ac](https://github.com/jinshuju/mcp/commit/538d2aceb618cc1625768faf95fd7a8da323dfbd))
* update tool copy_form ([d6f12c0](https://github.com/jinshuju/mcp/commit/d6f12c077c292755e4c171ccd0df7cd1154bbf5d))

## [0.3.0](https://github.com/jinshuju/mcp/compare/v0.2.0...v0.3.0) (2026-10-20)


### Features

* bucket tool failures for analytics and record the HTTP status ([7d9c340](https://github.com/jinshuju/mcp/commit/7d9c34019657ca73b95b906a7b1471310c901708))
* take filters, sort, metrics, dimensions and checks as arrays ([f3627cb](https://github.com/jinshuju/mcp/commit/f3627cb76186a9b281c1c7e49218969901fe48d4))

## [0.2.0](https://github.com/jinshuju/mcp/compare/v0.1.0...v0.2.0) (2026-10-16)


### Features

* add evals/ — multi-model MCP evaluation harness ([bbce160](https://github.com/jinshuju/mcp/commit/bbce160a080a3ce9d263134275bf2842cc324d82))
* add evals/ — multi-model MCP evaluation harness ([e6de35f](https://github.com/jinshuju/mcp/commit/e6de35f1100d464ccd429a81b1c2ee2e0e47dbd8))
* add routes and WDL session policy to wrangler configuration ([c29e96f](https://github.com/jinshuju/mcp/commit/c29e96f940bba3d71601e1cffd7929e8b8fb0137))
* follow openapi.yaml into English ([13a0388](https://github.com/jinshuju/mcp/commit/13a038870427168f55da748edd3a3dc74e4733c9))
* JINSHUJU_MCP_PUBLIC_URL accepts several addresses, chosen by Host ([a09d9fa](https://github.com/jinshuju/mcp/commit/a09d9fac617be3e843d49f96fdff7e3e40fe01e8))
* MCP server generated from openapi.yaml ([1d16c45](https://github.com/jinshuju/mcp/commit/1d16c453de6a5d71c2be236f47f949a12ad2ab38))
* report MCP usage to PostHog on HTTP deployments ([9ce33e7](https://github.com/jinshuju/mcp/commit/9ce33e733b1103a3531b84ab1bfb7c85b25604ae))
* report MCP usage to PostHog on HTTP deployments ([24c909e](https://github.com/jinshuju/mcp/commit/24c909eeea2274166321a8d4b5f861f7e10a2c39))
* report unexpected errors to Sentry on the Workers entry ([ab34c4a](https://github.com/jinshuju/mcp/commit/ab34c4acc327b4cbba5375b350b050c439aabb77))
* steer models between exam and evaluation forms, explain relative scoring ([25c9a35](https://github.com/jinshuju/mcp/commit/25c9a35688b914b631194fc6a6617ac75e406e92))
* steer models between exam and evaluation forms, explain relative scoring ([84fbe3b](https://github.com/jinshuju/mcp/commit/84fbe3bca56c415fc23bb07e5f49374a991d638a))
* sync tools with openapi.yaml ([ef28c50](https://github.com/jinshuju/mcp/commit/ef28c50327a5cd427a44803dc3b3d84617dcdcd6))
* sync tools with openapi.yaml ([ec73677](https://github.com/jinshuju/mcp/commit/ec7367755849895b6b2661898ff5c784ab0c20dd))
* sync tools with openapi.yaml ([babca28](https://github.com/jinshuju/mcp/commit/babca289486f50f7b282d461f950a88f67fc055d))
* sync tools with openapi.yaml ([f1bc242](https://github.com/jinshuju/mcp/commit/f1bc2423fca4af53b6daaf6ab3251b9d2d2ed59b))
* sync tools with openapi.yaml ([c243711](https://github.com/jinshuju/mcp/commit/c243711da68c4c41dd635562cb9dc8620a4d50a2))
* sync tools with openapi.yaml ([0bd44a0](https://github.com/jinshuju/mcp/commit/0bd44a0fe305b93502d15c38ab8479f8f5c5cffa))


### Fixes

* accept a trailing slash on /mcp instead of answering 404 ([f705943](https://github.com/jinshuju/mcp/commit/f70594300ffbe665f4ca01e858b426b3e52cf03a))
* accept scene on create_exam_form / create_evaluation_form ([bfa1435](https://github.com/jinshuju/mcp/commit/bfa1435d120ac023fbccae8f08e0f94086b7b572))
* add additional route for jinshuju.net to the configuration ([df153aa](https://github.com/jinshuju/mcp/commit/df153aa943e3e051604ae333ec8c6c7a445fce3d))
* always advertise https, ignore X-Forwarded-Proto ([c7d876d](https://github.com/jinshuju/mcp/commit/c7d876d7f895f4d218a48df6caf6f2eda53269cb))
* assume https when the proxy sends no X-Forwarded-Proto ([2bb421c](https://github.com/jinshuju/mcp/commit/2bb421cd5ac337f8bc9de508569c25d8d04498c0))
* call the global fetch unbound so workerd does not reject it ([b674383](https://github.com/jinshuju/mcp/commit/b6743837cbf696696b6432b2648959394366ff87))
* drop the NPS `between` filter note now that the API accepts it; add AGENT.md ([6f86558](https://github.com/jinshuju/mcp/commit/6f8655856ed3189673e199cabf7c5c0e6cd47cec))
* give each request its own PostHog client so one stuck flush cannot block all later ones ([e6d232e](https://github.com/jinshuju/mcp/commit/e6d232e6d8453e0812347321b8f9a548ba5b728c))
* name the offending parameters in validation errors; document NPS and multi-choice filters ([c353c40](https://github.com/jinshuju/mcp/commit/c353c409f60c55600214cec02908eff2be7ee8ec))
* name the offending parameters in validation errors; document NPS and multi-choice filters ([d6c10e4](https://github.com/jinshuju/mcp/commit/d6c10e4f77538393de8334558f61da66e12c51ce))
* send scene settings in the body shape each operation expects ([9fc2c37](https://github.com/jinshuju/mcp/commit/9fc2c3721333faf14269b132cc6f22e5ac4f0df9))
* serve correctly behind a path prefix on Workers-compatible platforms ([fe3566f](https://github.com/jinshuju/mcp/commit/fe3566f12bb272318b05c1d16ddbbb0d79602e48))
* steer pasted table data to create_entries; drop HTTP auth/multipart text from upload_import_file ([7249a41](https://github.com/jinshuju/mcp/commit/7249a4107567e1f4e5a7f269f57c6a47d74c2280))
* steer pasted table data to create_entries; drop HTTP auth/multipart text from upload_import_file ([3a217a9](https://github.com/jinshuju/mcp/commit/3a217a93b6f66d9005aeb92bdbe7f96402e59eac))
* stop exam / evaluation tool descriptions from suggesting a scene argument ([8ce2474](https://github.com/jinshuju/mcp/commit/8ce24747d590b0e57904de09c89a3ed51c9acd28))
* update model names and defaults in configuration ([43478a3](https://github.com/jinshuju/mcp/commit/43478a3c529d60c0d6732b2c5cdfc4b4ebe66f1c))
