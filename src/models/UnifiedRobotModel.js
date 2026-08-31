/**
 * Unified robot model data interface
 * All formats (URDF, MJCF, USD) are converted to this unified format
 */
export class UnifiedRobotModel {
    constructor() {
        this.name = '';
        this.links = new Map(); // Map<name, Link>
        this.joints = new Map(); // Map<name, Joint>
        this.materials = new Map(); // Map<name, Material>
        this.constraints = new Map(); // Map<name, Constraint> - for parallel mechanism constraints
        this.rootLink = null; // Root link name
        this.threeObject = null; // Three.js object (if available)
    }

    addLink(link) {
        this.links.set(link.name, link);
    }

    addJoint(joint) {
        this.joints.set(joint.name, joint);
    }

    addConstraint(constraint) {
        this.constraints.set(constraint.name, constraint);
    }

    getLink(name) {
        return this.links.get(name);
    }

    getJoint(name) {
        return this.joints.get(name);
    }

    getConstraint(name) {
        return this.constraints.get(name);
    }
}

/**
 * Link interface
 */
export class Link {
    constructor(name) {
        this.name = name;
        this.visuals = []; // VisualGeometry[]
        this.collisions = []; // CollisionGeometry[]
        this.inertial = null; // InertialProperties
        this.threeObject = null; // Three.js object
        this.userData = {}; // User-defined data (for adapters to store additional information)
    }
}

/**
 * VisualGeometry interface
 */
export class VisualGeometry {
    constructor() {
        this.name = '';
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.geometry = null; // GeometryType
        this.material = null; // Material
        this.threeObject = null; // Three.js Mesh
    }
}

/**
 * CollisionGeometry interface
 */
export class CollisionGeometry {
    constructor() {
        this.name = '';
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.geometry = null; // GeometryType
        this.threeObject = null; // Three.js Mesh
    }
}

/**
 * GeometryType interface
 */
export class GeometryType {
    constructor(type) {
        this.type = type; // 'plane' | 'box' | 'sphere' | 'cylinder' | 'capsule' | 'mesh'
        this.size = null; // Size parameters (varies by type)
        this.filename = null; // Mesh file path (if mesh type)
        this.infinite = false; // Infinite primitives should not define camera framing bounds
    }

    clone() {
        const cloned = new GeometryType(this.type);
        cloned.size = this.size ? { ...this.size } : null;
        cloned.filename = this.filename;
        cloned.infinite = this.infinite;
        return cloned;
    }
}

/**
 * InertialProperties interface
 */
export class InertialProperties {
    constructor() {
        this.mass = 0;
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.ixx = 0;
        this.iyy = 0;
        this.izz = 0;
        this.ixy = 0;
        this.ixz = 0;
        this.iyz = 0;
    }
}

/**
 * Joint interface
 */
export class Joint {
    constructor(name, type) {
        this.name = name;
        this.type = type; // 'revolute' | 'prismatic' | 'fixed' | 'continuous'
        this.parent = null; // Parent link name
        this.child = null; // Child link name
        this.origin = { xyz: [0, 0, 0], rpy: [0, 0, 0] };
        this.axis = { xyz: [0, 0, 1] }; // Default z-axis
        this.limits = null; // JointLimits
        this.currentValue = 0; // Current joint value
        this.threeObject = null; // Three.js object (if available)
    }
}

/**
 * JointLimits interface
 */
export class JointLimits {
    constructor() {
        this.lower = -Math.PI;
        this.upper = Math.PI;
        this.effort = null;
        this.velocity = null;
    }
}

/**
 * Material interface
 */
export class Material {
    constructor(name) {
        this.name = name;
        this.color = { r: 0.8, g: 0.8, b: 0.8 };
        this.texture = null;
    }
}

/**
 * Constraint interface - for describing closed-chain constraints of parallel mechanisms
 * Supports MuJoCo equality constraint types
 */
export class Constraint {
    constructor(name, type) {
        this.name = name;
        this.type = type; // 'connect' | 'weld' | 'joint' | 'tendon' | 'distance'

        // Constraint objects (may be body, geom, joint, etc. depending on type)
        this.body1 = null;
        this.body2 = null;
        this.anchor = null; // Connection point coordinates
        this.torquescale = null; // Torque scale

        // Joint constraint specific properties
        this.joint1 = null;
        this.joint2 = null;
        this.polycoef = null; // Polynomial coefficients [a0, a1, a2, a3, a4]

        // Visualization object
        this.threeObject = null; // Three.js object for displaying constraint

        // Original data (for debugging)
        this.userData = {};
    }
}
