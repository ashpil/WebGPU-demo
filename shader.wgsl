struct Camera {
    proj: mat4x4<f32>;
    view: mat4x4<f32>;
    position: vec3<f32>;
};

[[group(0), binding(0)]]
var<uniform> camera: Camera;

struct Model {
    to_world: mat4x4<f32>;
    to_obj_transpose: mat4x4<f32>;
};

[[group(1), binding(0)]]
var<uniform> model: Model;

struct Light {
    position: vec3<f32>;
    intensity: f32;
};

[[group(2), binding(0)]]
var<uniform> light: Light;

struct Material {
    color: vec3<f32>;
    roughness: f32;
};

[[group(3), binding(0)]]
var<uniform> material: Material;

struct VertexOutput {
    [[builtin(position)]] position: vec4<f32>;
    [[location(0)]] world_position: vec3<f32>;
    [[location(1)]] world_normal: vec3<f32>;
};

struct VertexInput {
    [[location(0)]] position: vec3<f32>;
    [[location(1)]] normal: vec3<f32>;
};

[[stage(vertex)]]
fn vertex_main(vert: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_position = model.to_world * vec4<f32>(vert.position, 1.0);
    out.world_position = world_position.xyz;
    out.world_normal = (model.to_obj_transpose * vec4<f32>(vert.normal, 0.0)).xyz;
    out.position = camera.proj * camera.view * world_position;
    return out;
}

let PI: f32 = 3.14159265358979323846264;

// The Fresnel reflection factor
//   i -- incoming direction
//   m -- microsurface normal
//   eta -- refractive index
fn fresnel(i: vec3<f32>, m: vec3<f32>, eta: f32) -> f32 {
    let c = abs(dot(i, m));
    let g = sqrt(eta * eta - 1.0 + c * c);

    let gmc = g - c;
    let gpc = g + c;
    let nom = c * (g + c) - 1.0;
    let denom = c * (g - c) + 1.0;
    return 0.5 * gmc * gmc / gpc / gpc * (1.0 + nom * nom / denom / denom);
}

// The one-sided Smith shadowing/masking function
//   v -- in or out vector
//   m -- microsurface normal
//   n -- (macro) surface normal
//   alpha -- surface roughness
fn G1(v: vec3<f32>, m: vec3<f32>, n: vec3<f32>, alpha: f32) -> f32 {
    let vm = dot(v, m);
    let vn = dot(v, n);
    var result: f32 = 0.0;
    if (vm * vn > 0.0) {
        let cosThetaV = dot(n, v);
        let sinThetaV2 = 1.0 - cosThetaV * cosThetaV;
        let tanThetaV2 = sinThetaV2 / cosThetaV / cosThetaV;
        result = 2.0 / (1.0 + sqrt(1.0 + alpha * alpha * tanThetaV2));
    }
    return result;
}

// The GGX slope distribution function
//   m -- microsurface normal
//   n -- (macro) surface normal
//   alpha -- surface roughness
fn D(m: vec3<f32>, n: vec3<f32>, alpha: f32) -> f32 {
    let mn = dot(m, n);
    var result: f32 = 0.0;
    if (mn > 0.0) {
        let cosThetaM = mn;
        let cosThetaM2 = cosThetaM * cosThetaM;
        let tanThetaM2 = (1.0 - cosThetaM2) / cosThetaM2;
        let cosThetaM4 =  cosThetaM * cosThetaM * cosThetaM * cosThetaM;
        let X = (alpha * alpha + tanThetaM2);
        result = alpha * alpha / (PI * cosThetaM4 * X * X);
    }
    return result;
}

// Evalutate the Microfacet BRDF (GGX variant) for the paramters:
//   i -- incoming direction (unit vector, pointing away from surface)
//   o -- outgoing direction (unit vector, pointing away from surface)
//   n -- outward pointing surface normal vector
//   eta -- refractive index
//   alpha -- surface roughness
// return: scalar BRDF value
fn isotropicMicrofacet(i: vec3<f32>, o: vec3<f32>, n: vec3<f32>, eta: f32, alpha: f32) -> f32 {
    let odotn = dot(o, n);
    let m = normalize(i + o);

    let idotn = dot(i,n);
    if (idotn <= 0.0 || odotn <= 0.0) {
        return 0.0;
    }

    let idotm = dot(i, m);
    var F: f32 = 0.0;
    if (idotm > 0.0) {
        F = fresnel(i,m,eta);
    }
    let G = G1(i, m, n, alpha) * G1(o, m, n, alpha);
    return F * G * D(m, n, alpha) / (4.0 * idotn * odotn);
}

[[stage(fragment)]]
fn fragment_main(vert: VertexOutput) -> [[location(0)]] vec4<f32> {
    let to_light = light.position - vert.world_position;
    let light_direction = normalize(to_light);
    let view_direction = normalize(camera.position - vert.world_position);
    let specular = isotropicMicrofacet(light_direction, view_direction, vert.world_normal, 1.5, material.roughness);
    let brdf = material.color / PI + vec3<f32>(specular);
    let r2 = dot(to_light, to_light);
    let k_light = light.intensity * max(dot(vert.world_normal, light_direction), 0.0) / (4.0 * PI * r2);
    return vec4<f32>(pow(brdf * k_light, vec3<f32>(1.0/2.2)), 1.0);
}

