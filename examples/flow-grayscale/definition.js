export const definition = {
  "typeId": "flow-grayscale/grayscale",
  "pluginId": "flow-grayscale",
  "pluginVersion": "1.0.0",
  "configVersion": 1,
  "category": "media",
  "workspaceRequired": false,
  "sideEffecting": false,
  "executable": true,
  "cachePolicy": "always",
  "defaultTitle": "Grayscale",
  "defaultConfig": {},
  "configSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "summaryFields": [],
  "ui": {
    "kind": "schema"
  },
  "parameters": [
    {
      "id": "image",
      "label": "Image",
      "mode": "connection",
      "dataTypes": [
        "image"
      ],
      "cardinality": "one",
      "required": true,
      "multiple": false,
      "defaultConnect": true
    }
  ],
  "outputs": [
    {
      "id": "image",
      "label": "Image",
      "dataTypes": [
        "image"
      ],
      "cardinality": "one",
      "defaultConnect": true
    }
  ],
  "handlerName": "grayscale"
};
