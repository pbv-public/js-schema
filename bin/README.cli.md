# JS Schema CLI Tool <!-- omit in toc -->
The command-line tool `bin/main.js` works with JS Schemas. You can tell it
which JS schemas to work with by pointing to a file which exports the schema(s):

### List schemas exported by a file
```javascript
$ node bin/main.js /path/to/my-schemas.js
```

By default, when it isn't given any other commands, this just prints out the
schemas it found:

```bash
$ node bin/main.js /path/to/basicTypes.js
JSON Schema IDs:
        /types/confidence
        /types/position/2d
        /types/position/3d
```

### Print the JSON Schema described by a JS Schema
To get the JSON Schema described by a JS Schema, specify the `$id` of the
schema and use the `--to-json-schema` option:

```bash
$ node bin/main.js /path/to/basicTypes.js /types/confidence --to-json-schema
{
  "type": "number",
  "minimum": 0,
  "maximum": 1,
  "description": "the confidence of some measurement",
  "$id": "/types/confidence",
  "$schema": "https://json-schema.org/draft/2020-12/schema"
}
```

### Validate JSON with a JS Schema
To check if some JSON matches the schema described by a JS schema, specify the
`$id` of the schema and pass the JSON data on stdin:

```bash
$ echo "0.7" | node bin/main.js /path/to/basicTypes.js /types/confidence
Valid!
```

If the JSON matched the schema, then the process exits with a successful status
code (0) and prints "Valid!" to stdout.

If the JSON doesn't match the schema, then the process exits with an error
status code (2) and prints information about the error to stderr.

```bash
$ echo "1.1" | node bin/main.js /path/to/basicTypes.js /types/confidence
.../schema.js:300
        throw new ValidationError(name, v, validate.errors, jsonSchema)
              ^

ValidationError: Validation Error: /types/confidence
    at assertValid (.../schema.js:300:15)
    at file:///.../bin/main.js:75:5 {
  badValue: 1.1,
  validationErrors: [
    {
      instancePath: '',
      schemaPath: '#/maximum',
      keyword: 'maximum',
      params: { comparison: '<=', limit: 1 },
      message: 'must be <= 1'
    }
  ],
  expectedSchema: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'the confidence of some measurement',
    '$id': '/types/confidence',
    '$schema': 'https://json-schema.org/draft/2020-12/schema'
  }
}
```
