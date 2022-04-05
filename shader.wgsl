struct Camera {
    proj: mat4x4<f32>;
    view: mat4x4<f32>;
};

[[group(0), binding(0)]]
var<uniform> camera: Camera;

struct Model {
    to_world: mat4x4<f32>;
};

[[group(1), binding(0)]]
var<uniform> model: Model;

struct VertexOutput {
    [[builtin(position)]] position: vec4<f32>;
    [[location(0)]] world_position: vec3<f32>;
};

struct VertexInput {
    [[location(0)]] position: vec3<f32>;
};

[[stage(vertex)]]
fn vertex_main(vert: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_position = model.to_world * vec4<f32>(vert.position, 1.0);
    out.world_position = world_position.xyz;
    out.position = camera.proj * camera.view * world_position;
    return out;
}

[[stage(fragment)]]
fn fragment_main(vert: VertexOutput) -> [[location(0)]] vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
