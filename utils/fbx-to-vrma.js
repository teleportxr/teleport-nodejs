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
                
                this.objects.models[id] = { id, name, type: 'Model' };
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
                        translation: { x: null, y: null, z: null }
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
                        console.log(`Assigned rotation curves to ${vrmBoneName} (${model.name})`);
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
        
        const vrmaData = {
            extensionsUsed: ["VRMC_vrm_animation"],
            extensions: {
                VRMC_vrm_animation: {
                    specVersion: "1.0-beta",
                    humanoid: {
                        humanBones: {}
                    }
                }
            },
            accessors: [],
            bufferViews: [],
            buffers: []
        };

        const bufferData = [];
        let bufferOffset = 0;
        let accessorIndex = 0;

        // Process each bone
        for (const [vrmBoneName, boneData] of Object.entries(animationData)) {
            const humanBone = {};
            
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
                    componentType: 5126, // FLOAT
                    count: times.length,
                    type: "SCALAR",
                    min: [Math.min(...times)],
                    max: [Math.max(...times)]
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: timeBuffer.length
                });
                
                const timeAccessorIndex = accessorIndex++;
                bufferOffset += timeBuffer.length;
                
                // Create rotation values (convert Euler to quaternion)
                const quaternions = [];
                for (let i = 0; i < times.length; i++) {
                    const x = (boneData.rotation.x?.values[i] || 0) * Math.PI / 180;
                    const y = (boneData.rotation.y?.values[i] || 0) * Math.PI / 180;
                    const z = (boneData.rotation.z?.values[i] || 0) * Math.PI / 180;
                    
                    // Convert Euler to quaternion
                    const quat = this.EulerToQuaternion(x, y, z);
                    quaternions.push(...quat);
                }
                
                const rotationBuffer = Buffer.from(new Float32Array(quaternions).buffer);
                bufferData.push(rotationBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    componentType: 5126, // FLOAT
                    count: times.length,
                    type: "VEC4"
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: rotationBuffer.length
                });
                
                const rotationAccessorIndex = accessorIndex++;
                bufferOffset += rotationBuffer.length;
                
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
                    componentType: 5126,
                    count: times.length,
                    type: "SCALAR",
                    min: [Math.min(...times)],
                    max: [Math.max(...times)]
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: timeBuffer.length
                });
                
                const timeAccessorIndex = accessorIndex++;
                bufferOffset += timeBuffer.length;
                
                // Create translation values
                const translations = [];
                for (let i = 0; i < times.length; i++) {
                    translations.push(
                        (boneData.translation.x?.values[i] || 0) / 100, // Convert cm to m
                        (boneData.translation.y?.values[i] || 0) / 100,
                        (boneData.translation.z?.values[i] || 0) / 100
                    );
                }
                
                const translationBuffer = Buffer.from(new Float32Array(translations).buffer);
                bufferData.push(translationBuffer);
                
                vrmaData.accessors.push({
                    bufferView: vrmaData.bufferViews.length,
                    componentType: 5126,
                    count: times.length,
                    type: "VEC3"
                });
                
                vrmaData.bufferViews.push({
                    buffer: 0,
                    byteOffset: bufferOffset,
                    byteLength: translationBuffer.length
                });
                
                const translationAccessorIndex = accessorIndex++;
                bufferOffset += translationBuffer.length;
                
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

        // Combine all buffer data
        const combinedBuffer = Buffer.concat(bufferData);
        vrmaData.buffers.push({
            byteLength: combinedBuffer.length
        });

        // Write VRMA file
        const vrmaJson = JSON.stringify(vrmaData, null, 2);
        const outputDir = path.dirname(outputPath);
        const baseName = path.basename(outputPath, '.vrma');
        
        // Write JSON
        fs.writeFileSync(outputPath, vrmaJson);
        
        // Write binary buffer
        const binPath = path.join(outputDir, `${baseName}.bin`);
        fs.writeFileSync(binPath, combinedBuffer);

        console.log(`\nVRMA file written to: ${outputPath}`);
        console.log(`Binary buffer written to: ${binPath}`);
        console.log(`Animated bones: ${Object.keys(vrmaData.extensions.VRMC_vrm_animation.humanoid.humanBones).length}`);
    }

    EulerToQuaternion(x, y, z) {
        // Convert Euler angles (in radians) to quaternion
        // Using XYZ order (adjust as needed for Mixamo)
        const c1 = Math.cos(x / 2);
        const c2 = Math.cos(y / 2);
        const c3 = Math.cos(z / 2);
        const s1 = Math.sin(x / 2);
        const s2 = Math.sin(y / 2);
        const s3 = Math.sin(z / 2);
        
        return [
            s1 * c2 * c3 + c1 * s2 * s3, // x
            c1 * s2 * c3 - s1 * c2 * s3, // y
            c1 * c2 * s3 + s1 * s2 * c3, // z
            c1 * c2 * c3 - s1 * s2 * s3  // w
        ];
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
