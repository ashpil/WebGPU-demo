import "/gl-matrix-min.js";

const FLOAT_SIZE = 4; // bytes
const VEC3_SIZE = FLOAT_SIZE * 3;
const MAT4_SIZE = FLOAT_SIZE * 16;

async function main() {
    // create initial context
    let ctx;
    try {
        ctx = await new Context();
    } catch(e) {
        alert("WebGPU is not supported/enabled in your browser.")
        throw e;
    }

    // load our shader module from file
    // WGSL lets fragment and vertex live in one file
    const shaderModule = await createShaderModule(ctx, "/shader.wgsl");

    // WebGPU requires you specify the layout of data before uploading it,
    // including binding information and what stages it is accessed in
    const vertFragLayout = ctx.device.createBindGroupLayout({ entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    }]});
    const vertLayout = ctx.device.createBindGroupLayout({ entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
    }]});
    const fragLayout = ctx.device.createBindGroupLayout({ entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
    }]});

    // our pipeline also has a fixed layout
    const pipelineLayout = ctx.device.createPipelineLayout({ bindGroupLayouts: [vertFragLayout, vertLayout, fragLayout, fragLayout] });
    const pipeline = createPipeline(ctx, shaderModule, pipelineLayout);

    // just wait until file uploaded, then proceed
    const inputElement = document.getElementById("file-input");
    inputElement.addEventListener("change", async function() {
        if (this.files.length > 0) {
            let scene = await new Scene(ctx, vertFragLayout, vertLayout, fragLayout, this.files[0]);
            requestAnimationFrame(() => render(ctx, pipeline, scene));
        }
    }, false);
}

// general context we need everywhere
class Context {
    constructor() {
        // theoretically having async constructors is "bad" in JS but this is easier
        return (async () => {
            if (navigator.gpu === undefined) {
                throw "Render Error: WebGPU unsupported";
            }

            // first need to get initial handles to gpu
            this.adapter = await navigator.gpu.requestAdapter();
            this.device = await this.adapter.requestDevice();

            // get canvas and configure it
            const canvas = document.getElementById("webgpu-canvas");
            canvas.width = canvas.width * 4; // scale it up a bit so image looks more crisp
            canvas.height = canvas.height * 4;
            this.surface = canvas.getContext("webgpu");
            this.aspect = canvas.width / canvas.height;
            this.surfaceFormat = this.surface.getPreferredFormat(this.adapter);
            this.surface.configure({
                device: this.device,
                format: this.surfaceFormat,
                usage: GPUTextureUsage.RENDER_ATTACHMENT
            });

            // need explicit depth texture for depth buffer
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

// glb data parser
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

// scene; contains meshes and camera
class Scene {
    constructor(ctx, vertFragLayout, vertLayout, fragLayout, glbFile) {
        return (async () => {
            const glbData = await new GlbData(glbFile);
            console.log(glbData);

            // load all of our materials
            this.materials = new Array();
            for (const material of glbData.json.materials) {
                const color = new Float32Array(material.pbrMetallicRoughness.baseColorFactor);
                const roughness = new Float32Array([material.pbrMetallicRoughness.roughnessFactor]);
                this.materials.push(new Material(ctx, fragLayout, color, roughness));
            }

            this.meshes = new Array();

            // iterate through top-level nodes and put them into recursion stack
            const stack = new Array();
            for (const node_index of glbData.json.scenes[0].nodes) {
                const mat = glMatrix.mat4.create();
                stack.push({ mat, node_index });
            }

            // iterate through all nodes, adding meshes with transforms as we find them
            // we don't store the heirarchy atm as this is easier to set up
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
                    this.camera = new Camera(ctx, vertFragLayout, glbData.json.cameras[current_node.camera].perspective, mat);
                }

                if ("extensions" in current_node) {
                    if ("KHR_lights_punctual" in current_node.extensions) {
                        // only use one point light for now
                        if (current_node.name.startsWith("Point")) {
                            const lightIndex = current_node.extensions.KHR_lights_punctual.light;
                            const light = glbData.json.extensions.KHR_lights_punctual.lights[lightIndex];
                            const position = glMatrix.vec3.create();
                            glMatrix.vec3.transformMat4(position, position, mat);
                            this.light = new Light(ctx, fragLayout, position, light.intensity);
                        }
                    }
                }

                if ("mesh" in current_node) {
                    const mesh = glbData.json.meshes[current_node.mesh];
                    const primitive = mesh.primitives[0]; // assume just one primitive

                    // we keep normal and position buffers seperate as this is simpler atm

                    const positionIndex = primitive.attributes["POSITION"];
                    const positionView = glbData.json.bufferViews[positionIndex];
                    const positionBuffer = await glbData.binary.slice(positionView.byteOffset, positionView.byteOffset + positionView.byteLength).arrayBuffer();

                    const normalIndex = primitive.attributes["NORMAL"];
                    const normalView = glbData.json.bufferViews[normalIndex];
                    const normalBuffer = await glbData.binary.slice(normalView.byteOffset, normalView.byteOffset + normalView.byteLength).arrayBuffer();

                    const indicesIndex = primitive.indices;
                    const indicesView = glbData.json.bufferViews[indicesIndex];
                    const indicesBuffer = await glbData.binary.slice(indicesView.byteOffset, indicesView.byteOffset + indicesView.byteLength).arrayBuffer();

                    this.meshes.push(new Mesh(ctx, vertLayout, positionBuffer, normalBuffer, indicesBuffer, primitive.material, mat));
                }
            }

            return this;
        })();
    }
}

// mesh contains vertex buffer, index buffer and transform
//
// we have each mesh "own" a GPU buffer with a transform, as webgpu needs data uploaded ahead of time to render, which means we can't just loop over the meshes, setting the transform into a buffer, rendering, and repeating, as you would in OpenGL
//
// this isn't very efficient and doesn't play well with animation, so not sure how this is typically accomplished with webgpu currently
//
// in Vulkan, you'd create a push constant, which lets you do essentially that temporary opengl data thing. WebGPU says its going to support them but afaik not yet
class Mesh {
    constructor(ctx, meshLayout, positionBuffer, normalBuffer, indexBuffer, materialIndex, mat) {
        this.materialIndex = materialIndex;

        // create positions buffer
        this.positions = ctx.device.createBuffer({
            size: positionBuffer.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true
        });
        new Uint8Array(this.positions.getMappedRange()).set(new Uint8Array(positionBuffer));
        this.positions.unmap();

        // create normals buffer
        this.normals = ctx.device.createBuffer({
            size: normalBuffer.byteLength,
            usage: GPUBufferUsage.VERTEX,
            mappedAtCreation: true
        });
        new Uint8Array(this.normals.getMappedRange()).set(new Uint8Array(normalBuffer));
        this.normals.unmap();

        // create index buffer
        this.indices = ctx.device.createBuffer({
            size: indexBuffer.byteLength,
            usage: GPUBufferUsage.INDEX,
            mappedAtCreation: true
        });
        new Uint8Array(this.indices.getMappedRange()).set(new Uint8Array(indexBuffer));
        this.indices.unmap();

        // transform
        const matrixBuffer = ctx.device.createBuffer({
            size: MAT4_SIZE * 2,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true,
        });

        new Float32Array(matrixBuffer.getMappedRange()).set(mat);
        const inv_transpose = glMatrix.mat4.create();
        glMatrix.mat4.invert(inv_transpose, mat);
        glMatrix.mat4.transpose(inv_transpose, inv_transpose);
        new Float32Array(matrixBuffer.getMappedRange()).set(inv_transpose, 16);
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

        this.indexCount = indexBuffer.byteLength / 2; // u16 indices
    }
}

class Light {
    constructor(ctx, layout, position, intensity) {
        const buffer = ctx.device.createBuffer({
            size: VEC3_SIZE + FLOAT_SIZE,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true, 
        });

        new Float32Array(buffer.getMappedRange()).set(position);
        new Float32Array(buffer.getMappedRange()).set(new Float32Array([intensity]), 3);
        buffer.unmap();

        this.data = ctx.device.createBindGroup({
            layout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer,
                    },
                },
            ],
        });
    }
}

class Material {
    constructor(ctx, layout, color, roughness) {
        const buffer = ctx.device.createBuffer({
            size: VEC3_SIZE + FLOAT_SIZE,
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true, 
        });

        new Float32Array(buffer.getMappedRange()).set(color);
        new Float32Array(buffer.getMappedRange()).set(new Float32Array([roughness]), 3);
        buffer.unmap();

        this.data = ctx.device.createBindGroup({
            layout,
            entries: [
                {
                    binding: 0,
                    resource: {
                        buffer,
                    },
                },
            ],
        });
    }
}

class Camera {
    constructor(ctx, layout, info, mat) {
        const matrices_buffer = ctx.device.createBuffer({
            size: MAT4_SIZE * 2 + VEC3_SIZE + FLOAT_SIZE, // need to pad
            usage: GPUBufferUsage.UNIFORM,
            mappedAtCreation: true, 
        });

        const proj = glMatrix.mat4.create();
        glMatrix.mat4.perspective(proj, info.yfov, ctx.aspect, info.znear, info.zfar);
        new Float32Array(matrices_buffer.getMappedRange()).set(proj);

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
        new Float32Array(matrices_buffer.getMappedRange()).set(eye, 32);

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

function createPipeline(ctx, shaderModule, pipelineLayout) {
    const renderPipeline = ctx.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
            module: shaderModule,
            entryPoint: "vertex_main",
            buffers: [
                {
                    arrayStride: VEC3_SIZE,
                    attributes: [
                        { format: "float32x3", offset: 0, shaderLocation: 0 }, // positions
                    ],
                },
                {
                    arrayStride: VEC3_SIZE,
                    attributes: [
                        { format: "float32x3", offset: 0, shaderLocation: 1 }, // normals
                    ],
                },
            ]
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

    // record GPU commands
    const renderPass = encoder.beginRenderPass({
        colorAttachments: [{
            view,
            storeOp: "store",
            loadOp: "clear",
            loadValue: [0.6, 0.6, 0.8, 1] // background color
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
    renderPass.setBindGroup(2, scene.light.data);

    for (const mesh of scene.meshes) {
        renderPass.setBindGroup(1, mesh.to_world);
        renderPass.setBindGroup(3, scene.materials[mesh.materialIndex].data);
        renderPass.setVertexBuffer(0, mesh.positions);
        renderPass.setVertexBuffer(1, mesh.normals);
        renderPass.setIndexBuffer(mesh.indices, "uint16");
        renderPass.drawIndexed(mesh.indexCount);
    }

    renderPass.endPass();

    // submit GPU commands
    ctx.device.queue.submit([encoder.finish()]);
}

await main();

