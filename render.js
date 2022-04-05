import "/gl-matrix-min.js";

class Context {
    constructor() {
        return (async () => {
            if (navigator.gpu === undefined) {
                throw "Render Error: WebGPU unsupported";
            }

            this.adapter = await navigator.gpu.requestAdapter();
            this.device = await this.adapter.requestDevice();

            const canvas = document.getElementById("webgpu-canvas");
            canvas.width = canvas.width * 4; // scale it up a bit so image looks more crisp
            canvas.height = canvas.height * 4;
            this.surface = canvas.getContext("webgpu");

            this.surfaceFormat = this.surface.getPreferredFormat(this.adapter);
            this.surface.configure({
                device: this.device,
                format: this.surfaceFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            });

            this.depthFormat = "depth32float";
            this.depthTexture = this.device.createTexture({
                size: {
                    width: canvas.width,
                    height: canvas.height,
                    depth: 1
                },
                format: this.depthFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            });

            return this;
        })();
    }
}

class GlbData {
    constructor(file) {
        return (async () => {
            const glb_header_size = 12; // bytes
            const chunk_header_size = 8;

            const header = new Uint32Array(await file.slice(0, glb_header_size).arrayBuffer());
            // make sure magic number is valid
            if (header[0] !== 0x46546C67) {
                throw "Invalid GLB file!";
            }

            const json_header = new Uint32Array(await file.slice(glb_header_size, glb_header_size + chunk_header_size).arrayBuffer());
            if (json_header[1] != 0x4E4F534A) {
                throw "Unsupported GLB file!";
            }
            const json_length = json_header[0];
            const text = await file.slice(glb_header_size + chunk_header_size, glb_header_size + chunk_header_size + json_length).text();
            this.json = JSON.parse(text);

            const binary_offset =  glb_header_size + chunk_header_size + json_length;
            const binary_header = new Uint32Array(await file.slice(binary_offset, binary_offset + chunk_header_size).arrayBuffer());
            if (binary_header[1] != 0x4E4942) {
                throw "Unsupported GLB file!";
            }
            const binary_size = binary_header[0];
            this.binary = await file.slice(binary_offset + chunk_header_size, binary_offset + chunk_header_size + binary_size);

            return this;
        })();
    }
}

class Scene {
    constructor(ctx, meshLayout, glbFile) {
        return (async () => {
            const glbData = await new GlbData(glbFile);
            console.log(glbData);

            this.meshes = new Array();

            // we need to iterate over the nodes to get camera and lights (don't need to but simplest this way)
            // iterate through top-level nodes
            const stack = new Array();
            for (const node_index of glbData.json.scenes[0].nodes) {
                const mat = glMatrix.mat4.create();
                stack.push({ mat, node_index });
            }

            while (stack.length) {
                const current = stack.pop();
                const current_node = glbData.json.nodes[current.node_index];
                let rotation = new Array(0, 0, 0, 1);
                if (current_node.rotation) {
                    rotation = current_node.rotation;
                }
                let translation = new Array(0, 0, 0);
                if (current_node.translation) {
                    translation = current_node.translation;
                }
                let scale = new Array(1, 1, 1);
                if (current_node.scale) {
                    scale = current_node.scale;
                }
                const mat = glMatrix.mat4.create();
                glMatrix.mat4.fromRotationTranslationScale(mat, rotation, translation, scale);
                glMatrix.mat4.multiply(mat, current.mat, mat);
                if (current_node.children) {
                    for (const node_index of current_node.children) {
                        stack.push({ mat, node_index });
                    }
                }

                if ("camera" in current_node) {
                    this.camera = new Camera(ctx, transformLayout, glbData.json.cameras[current_node.camera].perspective, mat); // TODO: does mat need to be inverted?
                }

                if ("mesh" in current_node) {
                    const mesh = glbData.json.meshes[current_node.mesh];
                    const primitive = mesh.primitives[0]; // assume just one primitive

                    const positionIndex = primitive.attributes["POSITION"];
                    const positionView = glbData.json.bufferViews[positionIndex];
                    const positionBuffer = await glbData.binary.slice(positionView.byteOffset, positionView.byteOffset + positionView.byteLength).arrayBuffer();

                    const indicesIndex = primitive.indices;
                    const indicesView = glbData.json.bufferViews[indicesIndex];
                    const indicesBuffer = await glbData.binary.slice(indicesView.byteOffset, indicesView.byteOffset + indicesView.byteLength).arrayBuffer();
                    this.meshes.push(new Mesh(ctx, meshLayout, positionBuffer, indicesBuffer, mat));
                }
            }

            return this;
        })();
    }
}

class Mesh {
    constructor(ctx, meshLayout, vertexBuffer, indexBuffer, mat) {
        // create vertex buffer
        this.vertices = ctx.device.createBuffer({
            size: vertexBuffer.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true
        });
        new Uint8Array(this.vertices.getMappedRange()).set(new Uint8Array(vertexBuffer));
        this.vertices.unmap();

        // create index buffer
        this.indices = ctx.device.createBuffer({
            size: indexBuffer.byteLength,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true
        });
        new Uint8Array(this.indices.getMappedRange()).set(new Uint8Array(indexBuffer));
        this.indices.unmap();

        const float_size = 4; // bytes
        const mat4_size = float_size * 16;

        const matrixBuffer = ctx.device.createBuffer({
            size: mat4_size,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true,
        });

        console.log(mat);
        new Float32Array(matrixBuffer.getMappedRange()).set(mat);
        matrixBuffer.unmap();

        this.to_world = ctx.device.createBindGroup({
            layout: meshLayout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: matrixBuffer,
                    },
                },
            ],
        });


        this.indexCount = indexBuffer.byteLength / 2;
    }
}

class Camera {
    constructor(ctx, layout, info, mat) {
        const float_size = 4; // bytes
        const mat4_size = float_size * 16;

        const matrices_buffer = ctx.device.createBuffer({
            size: mat4_size * 2,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true, 
        });

        const proj = glMatrix.mat4.create();
        glMatrix.mat4.perspective(proj, info.yfov, info.aspectRatio, info.znear, info.zfar);
        new Float32Array(matrices_buffer.getMappedRange()).set(proj);

        //let eye = mat.transform_point3(Vec3::new(0.0, 0.0, 0.0));
        //let target = mat.transform_point3(Vec3::new(0.0, 0.0, -1.0));
        //let up = mat.transform_vector3(Vec3::new(0.0, 1.0, 0.0));

        const eye = glMatrix.vec3.create();
        glMatrix.vec3.transformMat4(eye, eye, mat);

        const target = glMatrix.vec3.create();
        target[2] = -1.0;
        glMatrix.vec3.transformMat4(target, target, mat);

        const up = glMatrix.vec4.create();
        up[1] = 1.0;
        glMatrix.vec4.transformMat4(up, up, mat);

        const view = glMatrix.mat4.create();
        glMatrix.mat4.lookAt(view, eye, target, up);
        new Float32Array(matrices_buffer.getMappedRange()).set(view, 16);

        matrices_buffer.unmap();

        this.matrices = ctx.device.createBindGroup({
            layout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer: matrices_buffer,
                    },
                },
            ],
        });
    }
}

async function createShaderModule(ctx, filePath) {
    const fetchResponse = await fetch(filePath);
    const code = await fetchResponse.text();
    const shaderModule = ctx.device.createShaderModule({code}); // The API to get more info about shader compilation result is currently unimplemented, but theoretically exists
    return shaderModule;
}

function createPipeline(ctx, shaderModule, transformLayout) {
    const layout = ctx.device.createPipelineLayout({ bindGroupLayouts: [transformLayout, transformLayout] });
    const renderPipeline = ctx.device.createRenderPipeline({
        layout,
        vertex: {
            module: shaderModule,
            entryPoint: "vertex_main",
            buffers: [{
                arrayStride: 3 * 4, // in bytes
                attributes: [
                    { format: "float32x3", offset: 0, shaderLocation: 0 },
                ],
            }]
        },
        fragment: {
            module: shaderModule,
            entryPoint: "fragment_main",
            targets: [{ format: ctx.surfaceFormat }],
        },
        depthStencil: {
            format: ctx.depthFormat,
            depthWriteEnabled: true,
            depthCompare: "less"
        }
    });

    return renderPipeline;
}

function render(ctx, pipeline, scene) {
    const view = ctx.surface.getCurrentTexture().createView();

    const encoder = ctx.device.createCommandEncoder();

    const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
            view,
            storeOp: "store",
            loadOp: "clear",
            loadValue: [0.3, 0.3, 0.4, 1]
        }],
        depthStencilAttachment: {
            view: ctx.depthTexture.createView(),
            depthLoadValue: 1.0,
            depthStoreOp: "store",
            stencilLoadValue: 0,
            stencilStoreOp: "store"
        }
    });

    renderPass.setPipeline(pipeline);

    renderPass.setBindGroup(0, scene.camera.matrices);

    for (const mesh of scene.meshes) {
        renderPass.setBindGroup(1, mesh.to_world);
        renderPass.setVertexBuffer(0, mesh.vertices);
        renderPass.setIndexBuffer(mesh.indices, "uint16");
        renderPass.drawIndexed(mesh.indexCount);
    }
    console.log(scene);

    renderPass.endPass();

    ctx.device.queue.submit([encoder.finish()]);
}

let ctx;
try {
    ctx = await new Context();
} catch(e) {
    alert("WebGPU is not supported/enabled in your browser.")
    throw e;
}
console.log(ctx);

const shaderModule = await createShaderModule(ctx, "/shader.wgsl");

const transformLayout = ctx.device.createBindGroupLayout({ entries: [{
    binding: 0,
    visibility: GPUShaderStage.VERTEX,
}]});

const inputElement = document.getElementById("file-input");

const pipeline = createPipeline(ctx, shaderModule, transformLayout);

inputElement.addEventListener("change", async function() {
    if (this.files.length > 0) {
        let scene = await new Scene(ctx, transformLayout, this.files[0]);
        requestAnimationFrame(() => render(ctx, pipeline, scene));
    }
}, false);

