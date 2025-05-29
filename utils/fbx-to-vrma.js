const fs = require('fs');
const path = require('path');

// Mixamo bone mapping to VRM bones
const boneMapping = {
    // Core bones - with numbered prefix
    'mixamorig7:Hips': 'hips',
    'mixamorig7:Spine': 'spine',
    'mixamorig7:Spine1': 'chest',
    'mixamorig7:Spine2': 'upperChest',
    'mixamorig7:Neck': 'neck',
    'mixamorig7:Head': 'head',
    
    // Arms - with numbered prefix
    'mixamorig7:LeftShoulder': 'leftShoulder',
    'mixamorig7:LeftArm': 'leftUpperArm',
    'mixamorig7:LeftForeArm': 'leftLowerArm',
    'mixamorig7:LeftHand': 'leftHand',
    'mixamorig7:RightShoulder': 'rightShoulder',
    'mixamorig7:RightArm': 'rightUpperArm',
    'mixamorig7:RightForeArm': 'rightLowerArm',
    'mixamorig7:RightHand': 'rightHand',
    
    // Legs - with numbered prefix
    'mixamorig7:LeftUpLeg': 'leftUpperLeg',
    'mixamorig7:LeftLeg': 'leftLowerLeg',
    'mixamorig7:LeftFoot': 'leftFoot',
    'mixamorig7:LeftToeBase': 'leftToes',
    'mixamorig7:RightUpLeg': 'rightUpperLeg',
    'mixamorig7:RightLeg': 'rightLowerLeg',
    'mixamorig7:RightFoot': 'rightFoot',
    'mixamorig7:RightToeBase': 'rightToes',
    
    // Legacy mappings (without number)
    'mixamorig:Hips': 'hips',
    'mixamorig:Spine': 'spine',
    'mixamorig:Spine1': 'chest',
    'mixamorig:Spine2': 'upperChest',
    'mixamorig:Neck': 'neck',
    'mixamorig:Head': 'head',
    'mixamorig:LeftShoulder': 'leftShoulder',
    'mixamorig:LeftArm': 'leftUpperArm',
    'mixamorig:LeftForeArm': 'leftLowerArm',
    'mixamorig:LeftHand': 'leftHand',
    'mixamorig:RightShoulder': 'rightShoulder',
    'mixamorig:RightArm': 'rightUpperArm',
    'mixamorig:RightForeArm': 'rightLowerArm',
    'mixamorig:RightHand': 'rightHand',
    'mixamorig:LeftUpLeg': 'leftUpperLeg',
    'mixamorig:LeftLeg': 'leftLowerLeg',
    'mixamorig:LeftFoot': 'leftFoot',
    'mixamorig:LeftToeBase': 'leftToes',
    'mixamorig:RightUpLeg': 'rightUpperLeg',
    'mixamorig:RightLeg': 'rightLowerLeg',
    'mixamorig:RightFoot': 'rightFoot',
    'mixamorig:RightToeBase': 'rightToes',
    
    // Generic mappings (no prefix)
    'Hips': 'hips',
    'Spine': 'spine',
    'Spine1': 'chest',
    'Spine2': 'upperChest',
    'Neck': 'neck',
    'Head': 'head',
    'LeftShoulder': 'leftShoulder',
    'LeftArm': 'leftUpperArm',
    'LeftForeArm': 'leftLowerArm',
    'LeftHand': 'leftHand',
    'RightShoulder': 'rightShoulder',
    'RightArm': 'rightUpperArm',
    'RightForeArm': 'rightLowerArm',
    'RightHand': 'rightHand',
    'LeftUpLeg': 'leftUpperLeg',
    'LeftLeg': 'leftLowerLeg',
    'LeftFoot': 'leftFoot',
    'LeftToeBase': 'leftToes',
    'RightUpLeg': 'rightUpperLeg',
    'RightLeg': 'rightLowerLeg',
    'RightFoot': 'rightFoot',
    'RightToeBase': 'rightToes'
};

class FbxToVrmaConverter {
    constructor() {
        this.Reset();
    }

    Reset() {
        this.objects = {
            models: {},
            animCurves: {},
            animCurveNodes: {}
        };
        this.connections = [];
        this.animationLength = 0;
        this.fps = 30;
    }

    // Helper function to map bone names flexibly
    GetVrmBoneName(fbxBoneName) {
        // Direct lookup first
        if (boneMapping[fbxBoneName]) {
            return boneMapping[fbxBoneName];
        }
        
        // Try stripping mixamorig number prefix
        const strippedName = fbxBoneName.replace(/^mixamorig\d+:/, '');
        
        // Try with generic mapping
        if (boneMapping[strippedName]) {
            return boneMapping[strippedName];
        }
        
        // Try with mixamorig: prefix
        if (boneMapping['mixamorig:' + strippedName]) {
            return boneMapping['mixamorig:' + strippedName];
        }
        
        return null;
    }

    ParseFbxFile(filePath) {
        console.log('Parsing FBX file...');
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        let currentSection = null;
        let currentObjectType = null;
        let currentObjectId = null;
        let lineIndex = 0;
        
        while (lineIndex < lines.length) {
            const line = lines[lineIndex];
            const trimmedLine = line.trim();
            
            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith(';')) {
                lineIndex++;
                continue;
            }
            
            // Detect main sections
            if (line.startsWith('Objects:')) {
                currentSection = 'Objects';
                lineIndex++;
                continue;
            } else if (line.startsWith('Connections:')) {
                currentSection = 'Connections';
                lineIndex++;
                continue;
            }
            
            // Parse based on current section
            if (currentSection === 'Objects') {
                lineIndex = this.ParseObjectsSection(lines, lineIndex);
            } else if (currentSection === 'Connections') {
                lineIndex = this.ParseConnectionsSection(lines, lineIndex);
            } else {
                lineIndex++;
            }
        }
        
        this.ProcessAnimationData();
        return this.BuildAnimationStructure();
    }

    ParseObjectsSection(lines, startIndex) {
        const line = lines[startIndex];
        const trimmedLine = line.trim();
        
        // Model (bone)
        if (trimmedLine.includes('Model:') && trimmedLine.includes('"Model::')) {
            const match = trimmedLine.match(/Model:\s*(\d+),\s*"Model::([^"]+)"/);
            if (match) {
                const id = match[1];
                const name = match[2];
                
                this.objects.models[id] = { 
                    id, 
                    name, 
                    type: 'Model',
                    properties: {
                        'Lcl Translation': [0, 0, 0],
                        'Lcl Rotation': [0, 0, 0],
                        'Lcl Scaling': [1, 1, 1],
                        'PreRotation': [0, 0, 0],
                        'PostRotation': [0, 0, 0],
                        'RotationPivot': [0, 0, 0],
                        'ScalingPivot': [0, 0, 0],
                        'RotationOffset': [0, 0, 0],
                        'ScalingOffset': [0, 0, 0],
                        'RotationOrder': 0
                    }
                };
                
                // Look for properties in the following lines
                let i = startIndex + 1;
                let braceLevel = 1;
                
                while (i < lines.length && braceLevel > 0) {
                    const propLine = lines[i].trim();
                    
                    // Track braces
                    if (propLine.includes('{')) braceLevel++;
                    if (propLine.includes('}')) braceLevel--;
                    
                    // Parse property lines
                    if (propLine.includes('P:')) {
                        // FBX property format: P: "name", "type", "flags", "flags2", value1, value2, value3
                        const propMatch = propLine.match(/P:\s*"([^"]+)"[^,]*,[^,]*,[^,]*,[^,]*,\s*([-\d.]+)(?:,\s*([-\d.]+))?(?:,\s*([-\d.]+))?/);
                        if (propMatch) {
                            const propName = propMatch[1];
                            const val1 = parseFloat(propMatch[2]) || 0;
                            const val2 = parseFloat(propMatch[3]) || 0;
                            const val3 = parseFloat(propMatch[4]) || 0;
                            
                            if (propName === 'RotationOrder') {
                                this.objects.models[id].properties[propName] = Math.round(val1);
                            } else if (this.objects.models[id].properties.hasOwnProperty(propName)) {
                                this.objects.models[id].properties[propName] = [val1, val2, val3];
                            }
                        }
                    }
                    
                    i++;
                }
                
                return i;
            }
            return startIndex + 1;
        }
        
        // AnimationCurveNode
        if (trimmedLine.includes('AnimationCurveNode:')) {
            const match = trimmedLine.match(/AnimationCurveNode:\s*(\d+),\s*"AnimCurveNode::([^"]*)".*?"([^"]*)?"/);
            if (match) {
                const id = match[1];
                const name = match[2] || '';
                
                // Extract property type from name (T for translation, R for rotation, S for scale)
                let property = 'unknown';
                if (name === 'T' || name.includes('Translation')) {
                    property = 'translation';
                } else if (name === 'R' || name.includes('Rotation')) {
                    property = 'rotation';
                } else if (name === 'S' || name.includes('Scale')) {
                    property = 'scale';
                }
                
                this.objects.animCurveNodes[id] = { 
                    id, 
                    name,
                    type: 'AnimationCurveNode',
                    property: property
                };
            }
            return startIndex + 1;
        }
        
        // AnimationCurve
        if (trimmedLine.includes('AnimationCurve:') && trimmedLine.includes('"AnimCurve::')) {
            const match = trimmedLine.match(/AnimationCurve:\s*(\d+),\s*"AnimCurve::([^"]*)".*?"?([^"]*)"?/);
            if (match) {
                const id = match[1];
                const name = match[2] || '';
                
                this.objects.animCurves[id] = {
                    id,
                    name,
                    type: 'AnimationCurve',
                    times: [],
                    values: [],
                    axis: null // Will be determined from AnimationCurveNode connection
                };
                
                // Parse the curve data
                let i = startIndex + 1;
                let braceLevel = 1; // We're inside the AnimationCurve braces
                
                while (i < lines.length && braceLevel > 0) {
                    const line = lines[i];
                    const trimmedLine = line.trim();
                    
                    // Track brace levels
                    if (trimmedLine.includes('{')) braceLevel++;
                    if (trimmedLine.includes('}')) braceLevel--;
                    
                    // Parse KeyTime
                    if (trimmedLine.startsWith('KeyTime:')) {
                        i++;
                        if (i < lines.length) {
                            this.objects.animCurves[id].times = this.ParseFbxTimeArray(lines[i]);
                        }
                    }
                    // Parse KeyValueFloat
                    else if (trimmedLine.startsWith('KeyValueFloat:')) {
                        i++;
                        if (i < lines.length) {
                            this.objects.animCurves[id].values = this.ParseFbxFloatArray(lines[i]);
                        }
                    }
                    
                    i++;
                }
                return i;
            }
        }
        
        return startIndex + 1;
    }

    ParseConnectionsSection(lines, startIndex) {
        const line = lines[startIndex];
        const trimmedLine = line.trim();
        
        if (trimmedLine.startsWith('C:') || trimmedLine.startsWith(';C:')) {
            // Updated regex to capture optional 4th parameter
            const match = trimmedLine.match(/C:\s*"([^"]+)",\s*(\d+),\s*(\d+)(?:,\s*"([^"]+)")?/);
            if (match) {
                this.connections.push({
                    type: match[1],
                    sourceId: match[2],
                    targetId: match[3],
                    property: match[4] || null
                });
            }
        }
        
        return startIndex + 1;
    }

    ExtractProperty(name) {
        if (name.toLowerCase().includes('rotation') || name.includes('Lcl Rotation')) {
            return 'rotation';
        } else if (name.toLowerCase().includes('translation') || name.includes('Lcl Translation')) {
            return 'translation';
        } else if (name.toLowerCase().includes('scaling') || name.includes('Lcl Scaling')) {
            return 'scale';
        }
        return 'unknown';
    }

    ExtractAxis(name) {
        const lowerName = name.toLowerCase();
        if (lowerName.includes('d|x') || lowerName.includes('d_x') || lowerName.endsWith('_x')) {
            return 'x';
        } else if (lowerName.includes('d|y') || lowerName.includes('d_y') || lowerName.endsWith('_y')) {
            return 'y';
        } else if (lowerName.includes('d|z') || lowerName.includes('d_z') || lowerName.endsWith('_z')) {
            return 'z';
        }
        return null;
    }

    ParseFbxFloatArray(line) {
        const cleanLine = line.replace(/^\s*a:\s*/, '');
        return cleanLine.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
    }

    ParseFbxTimeArray(line) {
        const FBX_TIME_UNIT = 46186158000;
        const cleanLine = line.replace(/^\s*a:\s*/, '');
        return cleanLine.split(',').map(v => {
            const time = parseFloat(v.trim());
            return time / FBX_TIME_UNIT;
        }).filter(v => !isNaN(v));
    }

    ProcessAnimationData() {
        // Calculate animation length
        for (const curve of Object.values(this.objects.animCurves)) {
            if (curve.times.length > 0) {
                const maxTime = Math.max(...curve.times);
                if (maxTime > this.animationLength) {
                    this.animationLength = maxTime;
                }
            }
        }
        
        console.log(`\nParsing complete:`);
        console.log(`- Found ${Object.keys(this.objects.models).length} models`);
        console.log(`- Found ${Object.keys(this.objects.animCurveNodes).length} animation curve nodes`);
        console.log(`- Found ${Object.keys(this.objects.animCurves).length} animation curves`);
        console.log(`- Found ${this.connections.length} connections`);
        console.log(`- Animation length: ${this.animationLength.toFixed(2)} seconds`);
    }

    BuildAnimationStructure() {
        const animationData = {};
        
        // Build connection map for faster lookup
        const connectionMap = {
            byTarget: {},
            bySource: {}
        };
        
        for (const conn of this.connections) {
            if (!connectionMap.byTarget[conn.targetId]) {
                connectionMap.byTarget[conn.targetId] = [];
            }
            connectionMap.byTarget[conn.targetId].push(conn);
            
            if (!connectionMap.bySource[conn.sourceId]) {
                connectionMap.bySource[conn.sourceId] = [];
            }
            connectionMap.bySource[conn.sourceId].push(conn);
        }
        
        // For each model, find its animation data
        for (const [modelId, model] of Object.entries(this.objects.models)) {
            const vrmBoneName = this.GetVrmBoneName(model.name);
            if (!vrmBoneName) continue;
            
            // Find AnimationCurveNodes connected to this model
            const modelConnections = connectionMap.byTarget[modelId] || [];
            
            for (const conn of modelConnections) {
                const curveNode = this.objects.animCurveNodes[conn.sourceId];
                if (!curveNode) continue;
                
                // Use the connection property to determine type if available
                let property = curveNode.property;
                if (conn.property) {
                    if (conn.property.includes('Translation')) {
                        property = 'translation';
                    } else if (conn.property.includes('Rotation')) {
                        property = 'rotation';
                    } else if (conn.property.includes('Scale')) {
                        property = 'scale';
                    }
                }
                
                // Find AnimationCurves connected to this AnimationCurveNode
                const curveNodeConnections = connectionMap.byTarget[conn.sourceId] || [];
                
                if (!animationData[vrmBoneName]) {
                    animationData[vrmBoneName] = {
                        rotation: { x: null, y: null, z: null },
                        translation: { x: null, y: null, z: null },
                        rotationOrder: this.GetRotationOrder(model.properties.RotationOrder || 0),
                        preRotation: model.properties.PreRotation || [0, 0, 0],
                        postRotation: model.properties.PostRotation || [0, 0, 0]
                    };
                }
                
                // Collect all curves connected to this node
                const curves = [];
                for (const curveConn of curveNodeConnections) {
                    const curve = this.objects.animCurves[curveConn.sourceId];
                    if (curve && curve.values.length > 0) {
                        curves.push(curve);
                    }
                }
                
                // Assign curves to axes based on connection order (X, Y, Z)
                if (curves.length >= 3) {
                    if (property === 'rotation') {
                        animationData[vrmBoneName].rotation.x = curves[0];
                        animationData[vrmBoneName].rotation.y = curves[1];
                        animationData[vrmBoneName].rotation.z = curves[2];
                        console.log(`Assigned rotation curves to ${vrmBoneName} (${model.name}) with order ${animationData[vrmBoneName].rotationOrder}`);
                    } else if (property === 'translation') {
                        animationData[vrmBoneName].translation.x = curves[0];
                        animationData[vrmBoneName].translation.y = curves[1];
                        animationData[vrmBoneName].translation.z = curves[2];
                        console.log(`Assigned translation curves to ${vrmBoneName} (${model.name})`);
                    }
                } else if (curves.length > 0) {
                    console.log(`Warning: ${vrmBoneName} (${model.name}) has ${curves.length} curves for ${property}, expected 3`);
                }
            }
        }
        
        console.log(`\nBuilt animation structure for ${Object.keys(animationData).length} bones`);
        
        return {
            animationData,
            animationLength: this.animationLength,
            fps: this.fps
        };
    }

    ConvertToVrma(data, outputPath) {
        console.log('\nConverting to VRMA format...');
        
        const { animationData, animationLength } = data;
        
        if (Object.keys(animationData).length === 0) {
            console.error('No animation data found for VRM bones!');
            return;
        }
        
        // Store animation data for node creation
        this.animationData = {};
        
        // Create glTF 2.0 compliant structure
        const vrmaData = {
            asset: {
                generator: "FBX to VRMA Converter",
                version: "2.0"
            },
            scene: 0,
            scenes: [
                {
                    name: "Scene"
                }
            ],
            nodes: [],
            animations: [
                {
                    name: "Animation",
                    channels: [],
                    samplers: []
                }
            ],
            accessors: [],
            bufferViews: [],
            buffers: [],
            extensionsUsed: ["VRMC_vrm_animation"],
            extensions: {
                VRMC_vrm_animation: {
                    specVersion: "1.0-beta",
                    humanoid: {
                        humanBones: {}
                    }
                }
            }
        };

        const bufferData = [];
        let bufferOffset = 0;
        let accessorIndex = 0;
        let samplerIndex = 0;

        // Process each bone
        for (const [vrmBoneName, boneData] of Object.entries(animationData)) {
            const humanBone = {};
            
            // Initialize animation data for this bone
            this.animationData[vrmBoneName] = {};
            
            // Process rotation
            if (boneData.rotation.x || boneData.rotation.y || boneData.rotation.z) {
                // Get the time array from any available curve
                const timeCurve = boneData.rotation.x || boneData.rotation.y || boneData.rotation.z;
                const times = timeCurve.times;
                
                if (times.length === 0) continue;
                
                // Create time accessor
                const timeBuffer = Buffer.from(new Float32Array(times).buffer);
                bufferData.push(timeBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    byteOffset: 0,
                    componentType: 5126, // FLOAT
                    count: times.length,
                    type: "SCALAR",
                    min: [Math.min(...times)],
                    max: [Math.max(...times)]
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: timeBuffer.length,
                    target: undefined // No target for animation data
                });
                
                const timeAccessorIndex = accessorIndex++;
                bufferOffset += timeBuffer.length;
                
                // Create rotation values (convert Euler to quaternion)
                const quaternions = [];
                for (let i = 0; i < times.length; i++) {
					// FBX uses degrees, convert to radians
					const fbxX = (boneData.rotation.x?.values[i] || 0) * Math.PI / 180;
					const fbxY = (boneData.rotation.y?.values[i] || 0) * Math.PI / 180;
					const fbxZ = (boneData.rotation.z?.values[i] || 0) * Math.PI / 180;
					
					// FBX to glTF/VRM coordinate system conversion
					// FBX: Right-handed, Y-up, Z-forward
					// glTF/VRM: Right-handed, Y-up, -Z-forward
					// This requires negating rotations around X and Y axes
					let x = fbxX;
					let y = fbxY;
					let z = fbxZ;
					
					// Apply pre-rotation with the converted values
					const rotationOrder = boneData.rotationOrder || 'XYZ';
					const quat = this.ApplyPreRotation(x, y, z, boneData.preRotation, rotationOrder);
					quaternions.push(quat[0], quat[1], quat[2], quat[3]);
					
					// Debug: Log first frame of specific bones
					if (i === 0 && (vrmBoneName === 'hips' || vrmBoneName === 'leftShoulder' || vrmBoneName === 'leftUpperArm')) {
						console.log(`\nDebug - ${vrmBoneName} first frame:`);
						console.log(`  FBX Rotation: X=${(fbxX * 180/Math.PI).toFixed(1)}° Y=${(fbxY * 180/Math.PI).toFixed(1)}° Z=${(fbxZ * 180/Math.PI).toFixed(1)}°`);
						console.log(`  PreRotation: X=${boneData.preRotation[0].toFixed(1)}° Y=${boneData.preRotation[1].toFixed(1)}° Z=${boneData.preRotation[2].toFixed(1)}°`);
						console.log(`  Converted: X=${(x * 180/Math.PI).toFixed(1)}° Y=${(y * 180/Math.PI).toFixed(1)}° Z=${(z * 180/Math.PI).toFixed(1)}°`);
						console.log(`  Quaternion: [${quat.map(v => v.toFixed(3)).join(', ')}]`);
					}
				}
				
                const rotationBuffer = Buffer.from(new Float32Array(quaternions).buffer);
                bufferData.push(rotationBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    byteOffset: 0,
                    componentType: 5126, // FLOAT
                    count: times.length,
                    type: "VEC4",
                    min: undefined, // Optional for rotations
                    max: undefined
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: rotationBuffer.length,
                    target: undefined
                });
                
                const rotationAccessorIndex = accessorIndex++;
                bufferOffset += rotationBuffer.length;
                
                // Add to glTF animation
                vrmaData.animations[0].samplers.push({
                    input: timeAccessorIndex,
                    output: rotationAccessorIndex,
                    interpolation: "LINEAR"
                });
                
                const rotationSamplerIndex = samplerIndex++;
                
                // Store sampler index for later use
                this.animationData[vrmBoneName].rotation = {
                    input: timeAccessorIndex,
                    output: rotationAccessorIndex,
                    interpolation: "LINEAR",
                    samplerIndex: rotationSamplerIndex
                };
                
                // Store for VRM extension
                humanBone.rotation = {
                    input: timeAccessorIndex,
                    output: rotationAccessorIndex,
                    interpolation: "LINEAR"
                };
            }
            
            // Process translation
            if (boneData.translation.x || boneData.translation.y || boneData.translation.z) {
                const timeCurve = boneData.translation.x || boneData.translation.y || boneData.translation.z;
                const times = timeCurve.times;
                
                if (times.length === 0) continue;
                
                // Create time accessor
                const timeBuffer = Buffer.from(new Float32Array(times).buffer);
                bufferData.push(timeBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    byteOffset: 0,
                    componentType: 5126,
                    count: times.length,
                    type: "SCALAR",
                    min: [Math.min(...times)],
                    max: [Math.max(...times)]
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: timeBuffer.length,
                    target: undefined
                });
                
                const timeAccessorIndex = accessorIndex++;
                bufferOffset += timeBuffer.length;
                
                // Create translation values
                const translations = [];
                
				// Also update the translation conversion:
				for (let i = 0; i < times.length; i++) {
					// FBX uses centimeters, convert to meters
					const fbxX = (boneData.translation.x?.values[i] || 0) / 100;
					const fbxY = (boneData.translation.y?.values[i] || 0) / 100;
					const fbxZ = (boneData.translation.z?.values[i] || 0) / 100;
					
					// FBX to glTF/VRM coordinate system conversion
					// Negate Z axis for coordinate system conversion
					let x = fbxX;
					let y = fbxY;
					let z = -fbxZ;
					
				//	translations.push(x, y, z);
				}
                
                const translationBuffer = Buffer.from(new Float32Array(translations).buffer);
                bufferData.push(translationBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    byteOffset: 0,
                    componentType: 5126,
                    count: times.length,
                    type: "VEC3",
                    min: undefined, // Could calculate bounds if needed
                    max: undefined
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: translationBuffer.length,
                    target: undefined
                });
                
                const translationAccessorIndex = accessorIndex++;
                bufferOffset += translationBuffer.length;
                
                // Add to glTF animation
                vrmaData.animations[0].samplers.push({
                    input: timeAccessorIndex,
                    output: translationAccessorIndex,
                    interpolation: "LINEAR"
                });
                
                const translationSamplerIndex = samplerIndex++;
                
                // Store sampler index for later use
                this.animationData[vrmBoneName].translation = {
                    input: timeAccessorIndex,
                    output: translationAccessorIndex,
                    interpolation: "LINEAR",
                    samplerIndex: translationSamplerIndex
                };
                
                // Store for VRM extension
                humanBone.translation = {
                    input: timeAccessorIndex,
                    output: translationAccessorIndex,
                    interpolation: "LINEAR"
                };
            }
            
            if (Object.keys(humanBone).length > 0) {
                vrmaData.extensions.VRMC_vrm_animation.humanoid.humanBones[vrmBoneName] = humanBone;
                console.log(`Added bone: ${vrmBoneName}`);
            }
        }

        // Create VRM skeleton nodes
        const skeletonData = this.CreateVrmSkeletonNodes();
        vrmaData.nodes = skeletonData.nodes;
        vrmaData.scenes[0].nodes = skeletonData.rootNodes;
        vrmaData.animations[0].channels = skeletonData.animationChannels;

        // Combine all buffer data
        const combinedBuffer = Buffer.concat(bufferData);
        
        // Update buffer definition
        if (combinedBuffer.length > 0) {
            vrmaData.buffers.push({
                byteLength: combinedBuffer.length,
                uri: `${path.basename(outputPath, '.vrma')}.bin`
            });
        }

        // Clean up empty animations only if truly empty
        if (!vrmaData.animations || 
            (vrmaData.animations[0].channels.length === 0 && 
             vrmaData.animations[0].samplers.length === 0)) {
            delete vrmaData.animations;
        }

        // Write files
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, '.vrma');
        
        // Create text subfolder
        const textDir = path.join(outputDir, 'text');
        if (!fs.existsSync(textDir)) {
            fs.mkdirSync(textDir, { recursive: true });
        }
        
        // Convert to JSON string
        const vrmaJson = JSON.stringify(vrmaData, null, 2);
        
        // Write JSON file to text folder
        const jsonPath = path.join(textDir, `${baseName}.vrma`);
        fs.writeFileSync(jsonPath, vrmaJson);
        
        // Write binary buffer to text folder
        if (combinedBuffer.length > 0) {
            const binPath = path.join(textDir, `${baseName}.bin`);
            fs.writeFileSync(binPath, combinedBuffer);
        }

        // Create GLB file with .vrma extension in original folder
        this.CreateGlbFile(vrmaData, combinedBuffer, outputPath);

        console.log(`\nConversion completed:`);
        console.log(`Text files written to: ${textDir}/`);
        console.log(`- JSON: ${baseName}.vrma`);
        if (combinedBuffer.length > 0) {
            console.log(`- Binary: ${baseName}.bin`);
        }
        console.log(`GLB file written to: ${outputPath}`);
        console.log(`Animated bones: ${Object.keys(vrmaData.extensions.VRMC_vrm_animation.humanoid.humanBones).length}`);
    }

    CreateVrmSkeletonNodes() {
        const nodes = [];
        const nodeIndices = {};
        
        // Define VRM skeleton hierarchy with standard T-pose transforms
        const vrmSkeleton = [
            { name: "hips", parent: null, translation: [0, 1.0, 0] },
            { name: "spine", parent: "hips", translation: [0, 0.1, 0] },
            { name: "chest", parent: "spine", translation: [0, 0.1, 0] },
            { name: "upperChest", parent: "chest", translation: [0, 0.1, 0] },
            { name: "neck", parent: "upperChest", translation: [0, 0.1, 0] },
            { name: "head", parent: "neck", translation: [0, 0.1, 0] },
            
            // Left arm
            { name: "leftShoulder", parent: "upperChest", translation: [0.05, 0.08, 0] },
            { name: "leftUpperArm", parent: "leftShoulder", translation: [0.12, 0, 0] },
            { name: "leftLowerArm", parent: "leftUpperArm", translation: [0.27, 0, 0] },
            { name: "leftHand", parent: "leftLowerArm", translation: [0.27, 0, 0] },
            
            // Right arm
            { name: "rightShoulder", parent: "upperChest", translation: [-0.05, 0.08, 0] },
            { name: "rightUpperArm", parent: "rightShoulder", translation: [-0.12, 0, 0] },
            { name: "rightLowerArm", parent: "rightUpperArm", translation: [-0.27, 0, 0] },
            { name: "rightHand", parent: "rightLowerArm", translation: [-0.27, 0, 0] },
            
            // Left leg
            { name: "leftUpperLeg", parent: "hips", translation: [0.09, -0.05, 0] },
            { name: "leftLowerLeg", parent: "leftUpperLeg", translation: [0, -0.42, 0] },
            { name: "leftFoot", parent: "leftLowerLeg", translation: [0, -0.42, 0] },
            { name: "leftToes", parent: "leftFoot", translation: [0, -0.05, 0.12] },
            
            // Right leg
            { name: "rightUpperLeg", parent: "hips", translation: [-0.09, -0.05, 0] },
            { name: "rightLowerLeg", parent: "rightUpperLeg", translation: [0, -0.42, 0] },
            { name: "rightFoot", parent: "rightLowerLeg", translation: [0, -0.42, 0] },
            { name: "rightToes", parent: "rightFoot", translation: [0, -0.05, 0.12] }
        ];
        
        // Create nodes and build index map
        for (let i = 0; i < vrmSkeleton.length; i++) {
            const bone = vrmSkeleton[i];
            const node = {
                name: bone.name,
                translation: bone.translation
            };
            
            nodes.push(node);
            nodeIndices[bone.name] = i;
        }
        
        // Set up parent-child relationships
        for (let i = 0; i < vrmSkeleton.length; i++) {
            const bone = vrmSkeleton[i];
            if (bone.parent && nodeIndices[bone.parent] !== undefined) {
                const parentIndex = nodeIndices[bone.parent];
                if (!nodes[parentIndex].children) {
                    nodes[parentIndex].children = [];
                }
                nodes[parentIndex].children.push(i);
            }
        }
        
        // Update animations to reference node indices
        const animationChannels = [];
        for (const [boneName, boneData] of Object.entries(this.animationData)) {
            const nodeIndex = nodeIndices[boneName];
            if (nodeIndex === undefined) continue;
            
            if (boneData.rotation && boneData.rotation.samplerIndex !== undefined) {
                animationChannels.push({
                    sampler: boneData.rotation.samplerIndex,
                    target: {
                        node: nodeIndex,
                        path: "rotation"
                    }
                });
            }
            
            if (boneData.translation && boneData.translation.samplerIndex !== undefined) {
                animationChannels.push({
                    sampler: boneData.translation.samplerIndex,
                    target: {
                        node: nodeIndex,
                        path: "translation"
                    }
                });
            }
        }
        
        return { nodes, animationChannels, rootNodes: [nodeIndices["hips"]] };
    }

    CreateGlbFile(gltfData, binaryBuffer, outputPath) {
        // Remove the uri from buffer definition for GLB
        const glbData = JSON.parse(JSON.stringify(gltfData)); // Deep clone
        if (glbData.buffers && glbData.buffers.length > 0) {
            delete glbData.buffers[0].uri;
        }

        // Convert JSON to buffer
        const jsonString = JSON.stringify(glbData);
        const jsonBuffer = Buffer.from(jsonString, 'utf8');

        // Pad JSON chunk to 4-byte boundary
        const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
        const jsonChunk = Buffer.concat([
            jsonBuffer,
            Buffer.alloc(jsonPadding, 0x20) // Space character for JSON padding
        ]);

        // Pad binary chunk to 4-byte boundary
        const binPadding = (4 - (binaryBuffer.length % 4)) % 4;
        const binChunk = Buffer.concat([
            binaryBuffer,
            Buffer.alloc(binPadding, 0x00) // Null bytes for binary padding
        ]);

        // GLB Header
        const glbHeader = Buffer.alloc(12);
        glbHeader.writeUInt32LE(0x46546C67, 0); // Magic: "glTF"
        glbHeader.writeUInt32LE(2, 4); // Version: 2
        glbHeader.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8); // Total length

        // JSON chunk header
        const jsonChunkHeader = Buffer.alloc(8);
        jsonChunkHeader.writeUInt32LE(jsonChunk.length, 0); // Chunk length
        jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // Chunk type: "JSON"

        // Binary chunk header
        const binChunkHeader = Buffer.alloc(8);
        binChunkHeader.writeUInt32LE(binChunk.length, 0); // Chunk length
        binChunkHeader.writeUInt32LE(0x004E4942, 4); // Chunk type: "BIN\0"

        // Combine all parts
        const glb = Buffer.concat([
            glbHeader,
            jsonChunkHeader,
            jsonChunk,
            binChunkHeader,
            binChunk
        ]);

        // Write GLB file with .vrma extension
        fs.writeFileSync(outputPath, glb);
    }

    ApplyPreRotation(x, y, z, preRotation, rotationOrder) {
		if (!preRotation || (preRotation[0] === 0 && preRotation[1] === 0 && preRotation[2] === 0)) {
			return this.EulerToQuaternion(x, y, z, rotationOrder);
		}
		
		const preX = preRotation[0] * Math.PI / 180;
		const preY = preRotation[1] * Math.PI / 180;
		const preZ = preRotation[2] * Math.PI / 180;
		
		const animQuat = this.EulerToQuaternion(x, y, z, rotationOrder);
		const preQuat = this.EulerToQuaternion(preX, preY, preZ, rotationOrder);
		
		// Multiply quaternions: result = pre * anim
		const result = this.MultiplyQuaternions( animQuat, preQuat);
		//pre * anim * post
		return preQuat;  // Return the combined rotation!
	}
    
    MultiplyQuaternions(q1, q2) {
        // q1 * q2
        const [x1, y1, z1, w1] = q1;
        const [x2, y2, z2, w2] = q2;
        
        return [
            w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
            w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
            w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
            w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2
        ];
    }

	ApplyRotations(x, y, z, preRotation, postRotation, rotationOrder) {
		let quat = this.EulerToQuaternion(x, y, z, rotationOrder);
		
		if (preRotation && (preRotation[0] !== 0 || preRotation[1] !== 0 || preRotation[2] !== 0)) {
			let preX = preRotation[0] * Math.PI / 180;
			let preY = preRotation[1] * Math.PI / 180;
			let preZ = preRotation[2] * Math.PI / 180;
			
			// Apply same coordinate conversion to pre-rotation
			preX = -preX;
			preY = -preY;
			
			const preQuat = this.EulerToQuaternion(preX, preY, preZ, rotationOrder);
			quat = this.MultiplyQuaternions(preQuat, quat);
		}
		
		if (postRotation && (postRotation[0] !== 0 || postRotation[1] !== 0 || postRotation[2] !== 0)) {
			let postX = postRotation[0] * Math.PI / 180;
			let postY = postRotation[1] * Math.PI / 180;
			let postZ = postRotation[2] * Math.PI / 180;
			
			// Apply same coordinate conversion to post-rotation
			postX = -postX;
			postY = -postY;
			
			const postQuat = this.EulerToQuaternion(postX, postY, postZ, rotationOrder);
			quat = this.MultiplyQuaternions(quat, postQuat);
		}
		
		return quat;
	}
    
    QuaternionToEuler(quat, order = 'XYZ') {
        const [x, y, z, w] = quat;
        
        // This is a simplified conversion - full implementation would handle all orders
        let ex, ey, ez;
        
        if (order === 'XYZ') {
            const sinr_cosp = 2 * (w * x + y * z);
            const cosr_cosp = 1 - 2 * (x * x + y * y);
            ex = Math.atan2(sinr_cosp, cosr_cosp);
            
            const sinp = 2 * (w * y - z * x);
            ey = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
            
            const siny_cosp = 2 * (w * z + x * y);
            const cosy_cosp = 1 - 2 * (y * y + z * z);
            ez = Math.atan2(siny_cosp, cosy_cosp);
        } else {
            // For now, default to XYZ for other orders
            // Full implementation would handle all 6 orders
            return this.QuaternionToEuler(quat, 'XYZ');
        }
        
        return { x: ex, y: ey, z: ez };
    }
    
    GetRotationOrder(orderValue) {
        // FBX rotation order enum values
        const rotationOrders = {
            0: 'XYZ',
            1: 'XZY',
            2: 'YZX',
            3: 'YXZ',
            4: 'ZXY',
            5: 'ZYX',
            6: 'SphericXYZ' // Rarely used
        };
        return rotationOrders[orderValue] || 'XYZ';
    }

    EulerToQuaternion(ex, ey, ez, order = 'XYZ') {
		
		let x = ex;
		let y = ey;
		let z = ez;
		const cos = Math.cos;
		const sin = Math.sin;

		const c1 = cos( x / 2 );
		const c2 = cos( y / 2 );
		const c3 = cos( z / 2 );

		const s1 = sin( x / 2 );
		const s2 = sin( y / 2 );
		const s3 = sin( z / 2 );
		var q={x:0,y:0,z:0,w:0};
		switch ( order ) {

			case 'XYZ':
				q.x = s1 * c2 * c3 + c1 * s2 * s3;
				q.y = c1 * s2 * c3 - s1 * c2 * s3;
				q.z = c1 * c2 * s3 + s1 * s2 * c3;
				q.w = c1 * c2 * c3 - s1 * s2 * s3;
				break;

			case 'YXZ':
				q.x = s1 * c2 * c3 + c1 * s2 * s3;
				q.y = c1 * s2 * c3 - s1 * c2 * s3;
				q.z = c1 * c2 * s3 - s1 * s2 * c3;
				q.w = c1 * c2 * c3 + s1 * s2 * s3;
				break;

			case 'ZXY':
				q.x = s1 * c2 * c3 - c1 * s2 * s3;
				q.y = c1 * s2 * c3 + s1 * c2 * s3;
				q.z = c1 * c2 * s3 + s1 * s2 * c3;
				q.w = c1 * c2 * c3 - s1 * s2 * s3;
				break;

			case 'ZYX':
				q.x = s1 * c2 * c3 - c1 * s2 * s3;
				q.y = c1 * s2 * c3 + s1 * c2 * s3;
				q.z = c1 * c2 * s3 - s1 * s2 * c3;
				q.w = c1 * c2 * c3 + s1 * s2 * s3;
				break;

			case 'YZX':
				q.x = s1 * c2 * c3 + c1 * s2 * s3;
				q.y = c1 * s2 * c3 + s1 * c2 * s3;
				q.z = c1 * c2 * s3 - s1 * s2 * c3;
				q.w = c1 * c2 * c3 - s1 * s2 * s3;
				break;

			case 'XZY':
				q.x = s1 * c2 * c3 - c1 * s2 * s3;
				q.y = c1 * s2 * c3 - s1 * c2 * s3;
				q.z = c1 * c2 * s3 + s1 * s2 * c3;
				q.w = c1 * c2 * c3 + s1 * s2 * s3;
				break;

			default:
				break;
		}
		return [q.x,q.y,q.z,q.w];
    }

    Convert(inputPath, outputPath) {
        console.log(`Converting ${inputPath} to VRMA format...`);
        
        try {
            this.Reset();
            const data = this.ParseFbxFile(inputPath);
            
            if (!data.animationData || Object.keys(data.animationData).length === 0) {
                throw new Error('No animation data found for VRM bones');
            }
            
            this.ConvertToVrma(data, outputPath);
            console.log('\nConversion completed successfully!');
        } catch (error) {
            console.error('Error during conversion:', error);
            throw error;
        }
    }
}

// CLI usage
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log('Usage: node fbx-to-vrma.js <input.fbx> <output.vrma>');
        process.exit(1);
    }
    
    const inputPath = args[0];
    const outputPath = args[1];
    
    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }
    
    const converter = new FbxToVrmaConverter();
    converter.Convert(inputPath, outputPath);
}

module.exports = FbxToVrmaConverter;