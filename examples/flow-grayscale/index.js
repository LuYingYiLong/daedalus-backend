import { definition } from "./definition.js";

export function register(api) {
  api.flowNodes.register(definition, async ({ inputs, host, signal }) => {
    signal.throwIfAborted();
    return { image: await host.processImage(inputs.image.artifactId, { kind: "grayscale" }) };
  });
}
