#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { program } = require('commander');

class VrmUpgrader {
    constructor() {
        this.warnings = [];
        this.errors = [];
    }

    async upgradeVrm(inputPath, outputPath) {
        try {
            console.log(`Upgrading VRM from ${inputPath} to ${outputPath}`);
            
            // Read the input VRM file
            const inputBuffer = fs.readFileSync(inputPath);
            const gltf = this.parseGltf(inputBuffer);
            
            // Validate it's a VRM 0.x file
            if (!this.isVrm0x(gltf)) {
                throw new Error('Input file is not a valid VRM 0.x file');
            }
            
            // Perform the upgrade
            const upgradedGltf = this.performUpgrade(gltf);
            
            // Write the output
            const outputBuffer = this.serializeGltf(upgradedGltf);
            fs.writeFileSync(outputPath, outputBuffer);
            
            this.printSummary();
            
        } catch (error) {
            console.error('Upgrade failed:', error.message);
            process.exit(1);
        }
    }

    parseGltf(buffer) {
        // Parse GLB format
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        
        // Check GLB magic
        const magic = view.getUint32(0, true);
        if (magic !== 0x46546C67) { // 'glTF'
            throw new Error('Not a valid GLB file');
        }
        
        const version = view.getUint32(4, true);
        const length = view.getUint32(8, true);
        
        // Read JSON chunk
        const jsonChunkLength = view.getUint32(12, true);
        const jsonChunkType = view.getUint32(16, true);
        
        if (jsonChunkType !== 0x4E4F534A) { // 'JSON'
            throw new Error('Invalid GLB format - JSON chunk not found');
        }
        
        const jsonStart = 20;
        const jsonBytes = buffer.slice(jsonStart, jsonStart + jsonChunkLength);
        const gltf = JSON.parse(jsonBytes.toString('utf8'));
        
        // Store binary data reference
        if (jsonStart + jsonChunkLength < buffer.length) {
            const binChunkLength = view.getUint32(jsonStart + jsonChunkLength, true);
            const binChunkType = view.getUint32(jsonStart + jsonChunkLength + 4, true);
            
            if (binChunkType === 0x004E4942) { // 'BIN\0'
                gltf._binaryData = buffer.slice(
                    jsonStart + jsonChunkLength + 8,
                    jsonStart + jsonChunkLength + 8 + binChunkLength
                );
            }
        }
        
        return gltf;
    }

    isVrm0x(gltf) {
        return gltf.extensions && 
               gltf.extensions.VRM && 
               gltf.extensions.VRM.specVersion && 
               gltf.extensions.VRM.specVersion.startsWith('0.');
    }

    performUpgrade(gltf) {
        console.log('Starting VRM upgrade process...');
        
        const vrm0 = gltf.extensions.VRM;
        const upgradedGltf = JSON.parse(JSON.stringify(gltf));
        
        // Remove old VRM extension
        delete upgradedGltf.extensions.VRM;
        
        // Initialize new VRM 1.0 extensions
        if (!upgradedGltf.extensions) {
            upgradedGltf.extensions = {};
        }
        
        upgradedGltf.extensions.VRMC_vrm = this.upgradeVrmCore(vrm0);
        upgradedGltf.extensions.VRMC_materials_mtoon = this.upgradeMaterials(gltf, vrm0);
        upgradedGltf.extensions.VRMC_springBone = this.upgradeSpringBone(vrm0);
        upgradedGltf.extensions.VRMC_node_constraint = this.upgradeConstraints(vrm0);
        
        // Update extension requirements
        if (!upgradedGltf.extensionsUsed) {
            upgradedGltf.extensionsUsed = [];
        }
        
        const newExtensions = [
            'VRMC_vrm',
            'VRMC_materials_mtoon',
            'VRMC_springBone',
            'VRMC_node_constraint'
        ];
        
        newExtensions.forEach(ext => {
            if (!upgradedGltf.extensionsUsed.includes(ext)) {
                upgradedGltf.extensionsUsed.push(ext);
            }
        });
        
        // Remove old VRM from extensionsUsed
        const vrmIndex = upgradedGltf.extensionsUsed.indexOf('VRM');
        if (vrmIndex > -1) {
            upgradedGltf.extensionsUsed.splice(vrmIndex, 1);
        }
        
        return upgradedGltf;
    }

    upgradeVrmCore(vrm0) {
        const vrmc = {
            specVersion: "1.0",
            meta: this.upgradeMeta(vrm0.meta),
            humanoid: this.upgradeHumanoid(vrm0.humanoid),
            lookAt: this.upgradeLookAt(vrm0.firstPerson, vrm0.lookAt),
            expressions: this.upgradeExpressions(vrm0.blendShapeMaster)
        };
        
        console.log('✓ Upgraded VRM core extension');
        return vrmc;
    }

    upgradeMeta(meta0) {
        if (!meta0) {
            this.warnings.push('No meta information found in source file');
            return {};
        }
        
        const meta1 = {
            name: meta0.title || "Untitled",
            version: meta0.version || "1.0",
            authors: meta0.author ? [meta0.author] : [],
            copyrightInformation: meta0.contactInformation || "",
            references: meta0.reference || "",
            thirdPartyLicenses: "",
            thumbnailImage: meta0.texture !== undefined ? meta0.texture : undefined,
            licenseUrl: this.convertLicenseUrl(meta0.allowedUserName),
            avatarPermission: this.convertAvatarPermission(meta0.allowedUserName),
            commercialUsage: this.convertCommercialUsage(meta0.commercialUssageName),
            creditNotation: this.convertCreditNotation(meta0.allowedUserName),
            redistribution: this.convertRedistribution(meta0.allowedUserName),
            modification: this.convertModification(meta0.allowedUserName)
        };
        
        return meta1;
    }

    convertLicenseUrl(allowedUserName) {
        // Map old license types to URLs where possible
        const licenseMap = {
            'OnlyAuthor': 'https://vrm.dev/licenses/1.0/only_author.html',
            'ExplicitlyLicensedPerson': 'https://vrm.dev/licenses/1.0/explicitly_licensed_person.html',
            'Everyone': 'https://vrm.dev/licenses/1.0/everyone.html'
        };
        
        return licenseMap[allowedUserName] || "";
    }

    convertAvatarPermission(allowedUserName) {
        const permissionMap = {
            'OnlyAuthor': 'onlyAuthor',
            'ExplicitlyLicensedPerson': 'onlySeparatelyLicensedPerson',
            'Everyone': 'everyone'
        };
        
        return permissionMap[allowedUserName] || 'onlyAuthor';
    }

    convertCommercialUsage(commercialUssageName) {
        const usageMap = {
            'Disallow': 'personalNonProfit',
            'Allow': 'personalProfit'
        };
        
        return usageMap[commercialUssageName] || 'personalNonProfit';
    }

    convertCreditNotation(allowedUserName) {
        return allowedUserName === 'Everyone' ? 'optional' : 'required';
    }

    convertRedistribution(allowedUserName) {
        return allowedUserName === 'Everyone' ? 'allow' : 'disallow';
    }

    convertModification(allowedUserName) {
        return allowedUserName === 'Everyone' ? 'allow' : 'disallow';
    }

    upgradeHumanoid(humanoid0) {
        if (!humanoid0) {
            this.warnings.push('No humanoid information found');
            return { humanBones: [] };
        }
        
        const humanoid1 = {
            humanBones: []
        };
        
        if (humanoid0.humanBones) {
            humanoid0.humanBones.forEach(bone => {
                if (bone.bone && bone.node !== undefined) {
                    humanoid1.humanBones.push({
                        bone: this.convertBoneName(bone.bone),
                        node: bone.node
                    });
                }
            });
        }
        
        return humanoid1;
    }

    convertBoneName(oldBoneName) {
        // VRM 1.0 uses the same bone names as 0.x in most cases
        const boneNameMap = {
            // Most bones remain the same, but some may need mapping
            'leftShoulder': 'leftShoulder',
            'rightShoulder': 'rightShoulder',
            // Add any specific mappings needed
        };
        
        return boneNameMap[oldBoneName] || oldBoneName;
    }

    upgradeLookAt(firstPerson0, lookAt0) {
        const lookAt1 = {
            offsetFromHeadBone: [0, 0, 0],
            type: 'bone'
        };
        
        if (firstPerson0 && firstPerson0.firstPersonBoneOffset) {
            lookAt1.offsetFromHeadBone = [
                firstPerson0.firstPersonBoneOffset.x || 0,
                firstPerson0.firstPersonBoneOffset.y || 0,
                firstPerson0.firstPersonBoneOffset.z || 0
            ];
        }
        
        if (lookAt0) {
            if (lookAt0.lookAtTypeName === 'BlendShape') {
                lookAt1.type = 'expression';
            }
            
            // Convert look at ranges
            if (lookAt0.lookAtHorizontalInner) {
                lookAt1.rangeMapHorizontalInner = {
                    inputMaxValue: lookAt0.lookAtHorizontalInner.xRange || 90,
                    outputScale: lookAt0.lookAtHorizontalInner.yRange || 10
                };
            }
            
            if (lookAt0.lookAtHorizontalOuter) {
                lookAt1.rangeMapHorizontalOuter = {
                    inputMaxValue: lookAt0.lookAtHorizontalOuter.xRange || 90,
                    outputScale: lookAt0.lookAtHorizontalOuter.yRange || 10
                };
            }
            
            if (lookAt0.lookAtVerticalDown) {
                lookAt1.rangeMapVerticalDown = {
                    inputMaxValue: lookAt0.lookAtVerticalDown.xRange || 90,
                    outputScale: lookAt0.lookAtVerticalDown.yRange || 10
                };
            }
            
            if (lookAt0.lookAtVerticalUp) {
                lookAt1.rangeMapVerticalUp = {
                    inputMaxValue: lookAt0.lookAtVerticalUp.xRange || 90,
                    outputScale: lookAt0.lookAtVerticalUp.yRange || 10
                };
            }
        }
        
        return lookAt1;
    }

    upgradeExpressions(blendShapeMaster0) {
        const expressions1 = {
            preset: {},
            custom: {}
        };
        
        if (!blendShapeMaster0 || !blendShapeMaster0.blendShapeGroups) {
            this.warnings.push('No blend shape groups found');
            return expressions1;
        }
        
        blendShapeMaster0.blendShapeGroups.forEach(group => {
            const expression = this.convertBlendShapeGroup(group);
            
            if (this.isPresetExpression(group.presetName)) {
                const presetName = this.convertPresetName(group.presetName);
                expressions1.preset[presetName] = expression;
            } else {
                const customName = group.name || `custom_${Object.keys(expressions1.custom).length}`;
                expressions1.custom[customName] = expression;
            }
        });
        
        return expressions1;
    }

    convertBlendShapeGroup(group) {
        const expression = {
            morphTargetBinds: [],
            materialColorBinds: [],
            textureTransformBinds: []
        };
        
        if (group.binds) {
            group.binds.forEach(bind => {
                if (bind.mesh !== undefined && bind.index !== undefined) {
                    expression.morphTargetBinds.push({
                        node: bind.mesh,
                        index: bind.index,
                        weight: bind.weight || 1.0
                    });
                }
            });
        }
        
        if (group.materialValues) {
            group.materialValues.forEach(matVal => {
                if (matVal.materialName && matVal.propertyName) {
                    const colorBind = {
                        material: this.findMaterialIndex(matVal.materialName),
                        type: this.convertMaterialPropertyType(matVal.propertyName),
                        targetValue: matVal.targetValue || [1, 1, 1, 1]
                    };
                    expression.materialColorBinds.push(colorBind);
                }
            });
        }
        
        return expression;
    }

    isPresetExpression(presetName) {
        const presetNames = [
            'neutral', 'joy', 'angry', 'sorrow', 'fun', 'surprised',
            'blink', 'blinkLeft', 'blinkRight',
            'lookUp', 'lookDown', 'lookLeft', 'lookRight',
            'aa', 'ih', 'ou', 'ee', 'oh'
        ];
        return presetNames.includes(presetName);
    }

    convertPresetName(oldPresetName) {
        const nameMap = {
            'joy': 'happy',
            'angry': 'angry',
            'sorrow': 'sad',
            'fun': 'relaxed',
            'surprised': 'surprised'
        };
        
        return nameMap[oldPresetName] || oldPresetName;
    }

    findMaterialIndex(materialName) {
        // This would need access to the materials array to find the index
        // For now, return 0 as placeholder
        this.warnings.push(`Material index lookup needed for: ${materialName}`);
        return 0;
    }

    convertMaterialPropertyType(propertyName) {
        const typeMap = {
            '_Color': 'baseColorFactor',
            '_EmissionColor': 'emissiveFactor',
            '_OutlineColor': 'outlineColorFactor'
        };
        
        return typeMap[propertyName] || 'baseColorFactor';
    }

    upgradeMaterials(gltf, vrm0) {
        const mtoon1 = {};
        
        if (!gltf.materials) {
            return mtoon1;
        }
        
        gltf.materials.forEach((material, index) => {
            if (material.extensions && material.extensions.VRM) {
                // This material uses VRM 0.x MToon
                const mtoonData = this.convertMtoonMaterial(material.extensions.VRM);
                if (mtoonData) {
                    mtoon1[index] = mtoonData;
                }
            }
        });
        
        if (Object.keys(mtoon1).length > 0) {
            console.log(`✓ Upgraded ${Object.keys(mtoon1).length} MToon materials`);
        }
        
        return mtoon1;
    }

    convertMtoonMaterial(vrmMaterial) {
        // Convert VRM 0.x material properties to VRM 1.0 MToon
        const mtoon1 = {
            specVersion: "1.0",
            transparentWithZWrite: vrmMaterial.transparentWithZWrite || false,
            renderQueueOffsetNumber: vrmMaterial.renderQueue ? vrmMaterial.renderQueue - 3000 : 0,
            shadeColorFactor: vrmMaterial.shadeColor || [1, 1, 1],
            shadeMultiplyTexture: vrmMaterial.shadeTexture ? { index: vrmMaterial.shadeTexture } : undefined,
            shadingShiftFactor: vrmMaterial.shadingShiftValue || 0,
            shadingToonyFactor: vrmMaterial.shadingToonyValue || 0.9,
            rimColorFactor: vrmMaterial.rimColor || [0, 0, 0],
            rimLightingMixFactor: vrmMaterial.rimLightingMix || 0,
            rimFresnelPowerFactor: vrmMaterial.rimFresnelPower || 1,
            rimMultiplyTexture: vrmMaterial.rimTexture ? { index: vrmMaterial.rimTexture } : undefined,
            outlineWidthMode: this.convertOutlineWidthMode(vrmMaterial.outlineWidthMode),
            outlineWidthFactor: vrmMaterial.outlineWidth || 0,
            outlineColorFactor: vrmMaterial.outlineColor || [0, 0, 0],
            outlineLightingMixFactor: vrmMaterial.outlineLightingMix || 1,
            uvAnimationMaskTexture: vrmMaterial.uvAnimMaskTexture ? { index: vrmMaterial.uvAnimMaskTexture } : undefined,
            uvAnimationScrollXSpeedFactor: vrmMaterial.uvAnimScrollX || 0,
            uvAnimationScrollYSpeedFactor: vrmMaterial.uvAnimScrollY || 0,
            uvAnimationRotationSpeedFactor: vrmMaterial.uvAnimRotation || 0
        };
        
        return mtoon1;
    }

    convertOutlineWidthMode(oldMode) {
        const modeMap = {
            'None': 'none',
            'WorldCoordinates': 'worldCoordinates',
            'ScreenCoordinates': 'screenCoordinates'
        };
        
        return modeMap[oldMode] || 'none';
    }

    upgradeSpringBone(vrm0) {
        const springBone1 = {
            specVersion: "1.0",
            springs: [],
            joints: [],
            colliderGroups: [],
            colliders: []
        };
        
        if (!vrm0.secondaryAnimation) {
            return springBone1;
        }
        
        const secondary = vrm0.secondaryAnimation;
        
        // Convert collider groups
        if (secondary.colliderGroups) {
            secondary.colliderGroups.forEach((group, groupIndex) => {
                springBone1.colliderGroups.push({
                    name: group.name || `ColliderGroup_${groupIndex}`,
                    colliders: []
                });
                
                if (group.colliders) {
                    group.colliders.forEach(collider => {
                        const colliderIndex = springBone1.colliders.length;
                        springBone1.colliders.push({
                            node: group.node,
                            shape: {
                                sphere: {
                                    offset: [
                                        collider.offset.x || 0,
                                        collider.offset.y || 0,
                                        collider.offset.z || 0
                                    ],
                                    radius: collider.radius || 0
                                }
                            }
                        });
                        
                        springBone1.colliderGroups[groupIndex].colliders.push(colliderIndex);
                    });
                }
            });
        }
        
        // Convert bone groups to springs and joints
        if (secondary.boneGroups) {
            secondary.boneGroups.forEach((boneGroup, springIndex) => {
                const jointIndices = [];
                
                if (boneGroup.bones) {
                    boneGroup.bones.forEach(boneIndex => {
                        const jointIndex = springBone1.joints.length;
                        springBone1.joints.push({
                            node: boneIndex,
                            hitRadius: boneGroup.hitRadius || 0,
                            stiffness: boneGroup.stiffiness || 1, // Note: typo in original spec
                            gravityPower: boneGroup.gravityPower || 0,
                            gravityDir: [
                                boneGroup.gravityDir.x || 0,
                                boneGroup.gravityDir.y || -1,
                                boneGroup.gravityDir.z || 0
                            ],
                            dragForce: boneGroup.dragForce || 0.4
                        });
                        jointIndices.push(jointIndex);
                    });
                }
                
                springBone1.springs.push({
                    name: boneGroup.comment || `Spring_${springIndex}`,
                    joints: jointIndices,
                    colliderGroups: boneGroup.colliderGroups || []
                });
            });
        }
        
        if (springBone1.springs.length > 0) {
            console.log(`✓ Upgraded ${springBone1.springs.length} spring bone groups`);
        }
        
        return springBone1;
    }

    upgradeConstraints(vrm0) {
        // VRM 0.x doesn't have constraints, so return empty structure
        return {
            specVersion: "1.0",
            constraints: []
        };
    }

    serializeGltf(gltf) {
        const jsonString = JSON.stringify(gltf, null, 2);
        const jsonBuffer = Buffer.from(jsonString, 'utf8');
        
        // Pad to 4-byte boundary
        const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
        const paddedJsonBuffer = Buffer.concat([
            jsonBuffer,
            Buffer.alloc(jsonPadding, 0x20) // Space padding
        ]);
        
        // Create GLB structure
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546C67, 0); // 'glTF'
        header.writeUInt32LE(2, 4); // version
        
        const jsonChunkHeader = Buffer.alloc(8);
        jsonChunkHeader.writeUInt32LE(paddedJsonBuffer.length, 0);
        jsonChunkHeader.writeUInt32LE(0x4E4F534A, 4); // 'JSON'
        
        let totalLength = 12 + 8 + paddedJsonBuffer.length;
        let binChunkHeader = Buffer.alloc(0);
        let binaryData = Buffer.alloc(0);
        
        if (gltf._binaryData) {
            const binPadding = (4 - (gltf._binaryData.length % 4)) % 4;
            binaryData = Buffer.concat([
                gltf._binaryData,
                Buffer.alloc(binPadding, 0)
            ]);
            
            binChunkHeader = Buffer.alloc(8);
            binChunkHeader.writeUInt32LE(binaryData.length, 0);
            binChunkHeader.writeUInt32LE(0x004E4942, 4); // 'BIN\0'
            
            totalLength += 8 + binaryData.length;
        }
        
        header.writeUInt32LE(totalLength, 8);
        
        return Buffer.concat([
            header,
            jsonChunkHeader,
            paddedJsonBuffer,
            binChunkHeader,
            binaryData
        ]);
    }

    printSummary() {
        console.log('\n=== Upgrade Summary ===');
        console.log('✅ VRM upgrade completed successfully');
        
        if (this.warnings.length > 0) {
            console.log('\n⚠️  Warnings:');
            this.warnings.forEach(warning => console.log(`  - ${warning}`));
        }
        
        if (this.errors.length > 0) {
            console.log('\n❌ Errors:');
            this.errors.forEach(error => console.log(`  - ${error}`));
        }
        
        console.log('\nPlease test the upgraded VRM file in a VRM 1.0 compatible application.');
        console.log('Some manual adjustments may be required for optimal results.');
    }
}

// CLI setup
program
    .name('vrm-upgrader')
    .description('Upgrade VRM avatar models from version 0.x to 1.0')
    .version('1.0.0')
    .argument('<input>', 'Input VRM 0.x file path')
    .argument('<output>', 'Output VRM 1.0 file path')
    .option('-v, --verbose', 'Verbose output')
    .action(async (input, output, options) => {
        const upgrader = new VrmUpgrader();
        
        if (!fs.existsSync(input)) {
            console.error(`Error: Input file "${input}" does not exist`);
            process.exit(1);
        }
        
        const outputDir = path.dirname(output);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        await upgrader.upgradeVrm(input, output);
    });

// Run CLI if this script is executed directly
if (require.main === module) {
    program.parse();
}

module.exports = { VrmUpgrader };
