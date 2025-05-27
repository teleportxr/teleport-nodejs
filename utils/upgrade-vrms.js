#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { VrmUpgrader } = require('./vrm-upgrader'); // Assuming the previous script is saved as vrm-upgrader.js

class BatchVrmProcessor {
    constructor() {
        this.sourceDir = './assets/vrm';
        this.backupDir = './vrm0';
        
        this.stats = {
            totalFiles: 0,
            vrmFiles: 0,
            vrm0Files: 0,
            vrm1Files: 0,
            upgraded: 0,
            skipped: 0,
            errors: 0,
            warnings: []
        };
        
        this.upgrader = new VrmUpgrader();
    }

    async processDirectory() {
        console.log('🚀 Starting batch VRM upgrade process...');
        console.log(`📁 Source directory: ${path.resolve(this.sourceDir)}`);
        console.log(`💾 Backup directory: ${path.resolve(this.backupDir)}`);
        
        try {
            // Ensure directories exist
            this.ensureDirectories();
            
            // Find all VRM files
            const vrmFiles = this.findVrmFiles();
            
            if (vrmFiles.length === 0) {
                console.log('⚠️  No VRM files found in ./vrm directory');
                console.log('   Place your VRM files in the ./vrm folder and run again.');
                return;
            }
            
            console.log(`\n📊 Found ${vrmFiles.length} VRM files to process\n`);
            
            // Process each file
            for (const filePath of vrmFiles) {
                await this.processVrmFile(filePath);
            }
            
            // Print final summary
            this.printFinalSummary();
            
        } catch (error) {
            console.error('❌ Batch processing failed:', error.message);
            process.exit(1);
        }
    }

    ensureDirectories() {
        if (!fs.existsSync(this.sourceDir)) {
            console.log(`📁 Creating source directory: ${this.sourceDir}`);
            fs.mkdirSync(this.sourceDir, { recursive: true });
        }
        
        if (!fs.existsSync(this.backupDir)) {
            console.log(`📁 Creating backup directory: ${this.backupDir}`);
            fs.mkdirSync(this.backupDir, { recursive: true });
        }
    }

    findVrmFiles() {
        const vrmFiles = [];
        
        const scanDirectory = (dirPath) => {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                
                if (item.isDirectory()) {
                    // Recursively scan subdirectories
                    scanDirectory(fullPath);
                } else if (item.isFile()) {
                    this.stats.totalFiles++;
                    
                    // Check if it's a VRM file by extension
                    if (path.extname(item.name).toLowerCase() === '.vrm') {
                        vrmFiles.push(fullPath);
                        this.stats.vrmFiles++;
                    }
                }
            }
        };
        
        scanDirectory(this.sourceDir);
        return vrmFiles;
    }

    async processVrmFile(filePath) {
        const fileName = path.basename(filePath);
        const relativePath = path.relative(this.sourceDir, filePath);
        
        console.log(`\n🔄 Processing: ${relativePath}`);
        
        try {
            // Check VRM version
            const vrmVersion = this.detectVrmVersion(filePath);
            
            if (vrmVersion === null) {
                console.log(`⚠️  Skipping ${fileName} - Not a valid VRM file`);
                this.stats.skipped++;
                return;
            }
            
            if (vrmVersion.startsWith('1.')) {
                console.log(`✅ Skipping ${fileName} - Already VRM 1.0+ (${vrmVersion})`);
                this.stats.vrm1Files++;
                this.stats.skipped++;
                return;
            }
            
            if (!vrmVersion.startsWith('0.')) {
                console.log(`⚠️  Skipping ${fileName} - Unknown VRM version: ${vrmVersion}`);
                this.stats.skipped++;
                return;
            }
            
            this.stats.vrm0Files++;
            console.log(`📋 Found VRM ${vrmVersion} file`);
            
            // Create backup
            this.createBackup(filePath, relativePath);
            
            // Create temporary file for upgrade
            const tempPath = filePath + '.tmp';
            
            try {
                // Perform upgrade
                await this.upgrader.upgradeVrm(filePath, tempPath);
                
                // Replace original with upgraded version
                fs.renameSync(tempPath, filePath);
                
                console.log(`✅ Successfully upgraded: ${fileName}`);
                this.stats.upgraded++;
                
            } catch (upgradeError) {
                // Clean up temp file if it exists
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
                throw upgradeError;
            }
            
        } catch (error) {
            console.error(`❌ Error processing ${fileName}:`, error.message);
            this.stats.errors++;
            this.stats.warnings.push(`${fileName}: ${error.message}`);
        }
    }

    detectVrmVersion(filePath) {
        try {
            const buffer = fs.readFileSync(filePath);
            const gltf = this.parseGltfHeader(buffer);
            
            if (gltf.extensions) {
                // Check for VRM 1.0+ extensions
                if (gltf.extensions.VRMC_vrm) {
                    return gltf.extensions.VRMC_vrm.specVersion || '1.0';
                }
                
                // Check for VRM 0.x extension
                if (gltf.extensions.VRM) {
                    return gltf.extensions.VRM.specVersion || '0.0';
                }
            }
            
            return null; // Not a VRM file
            
        } catch (error) {
            return null;
        }
    }

    parseGltfHeader(buffer) {
        // Quick parse to get just the JSON header without full processing
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        
        // Check GLB magic
        const magic = view.getUint32(0, true);
        if (magic !== 0x46546C67) { // 'glTF'
            throw new Error('Not a GLB file');
        }
        
        // Read JSON chunk
        const jsonChunkLength = view.getUint32(12, true);
        const jsonChunkType = view.getUint32(16, true);
        
        if (jsonChunkType !== 0x4E4F534A) { // 'JSON'
            throw new Error('Invalid GLB format');
        }
        
        const jsonStart = 20;
        const jsonBytes = buffer.slice(jsonStart, jsonStart + jsonChunkLength);
        return JSON.parse(jsonBytes.toString('utf8'));
    }

    createBackup(originalPath, relativePath) {
        const backupPath = path.join(this.backupDir, relativePath);
        const backupDir = path.dirname(backupPath);
        
        // Ensure backup directory structure exists
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        // Copy file to backup location
        fs.copyFileSync(originalPath, backupPath);
        console.log(`💾 Backed up original file`);
    }

    printFinalSummary() {
        console.log('\n' + '='.repeat(50));
        console.log('📊 BATCH PROCESSING SUMMARY');
        console.log('='.repeat(50));
        
        console.log(`📁 Total files scanned: ${this.stats.totalFiles}`);
        console.log(`🎭 VRM files found: ${this.stats.vrmFiles}`);
        console.log(`📋 VRM 0.x files: ${this.stats.vrm0Files}`);
        console.log(`✅ VRM 1.0+ files: ${this.stats.vrm1Files}`);
        console.log(`🔄 Files upgraded: ${this.stats.upgraded}`);
        console.log(`⏭️  Files skipped: ${this.stats.skipped}`);
        console.log(`❌ Errors encountered: ${this.stats.errors}`);
        
        if (this.stats.upgraded > 0) {
            console.log(`\n🎉 Successfully upgraded ${this.stats.upgraded} VRM files!`);
            console.log(`💾 Original files backed up to: ${this.backupDir}`);
        }
        
        if (this.stats.warnings.length > 0) {
            console.log('\n⚠️  WARNINGS:');
            this.stats.warnings.forEach(warning => {
                console.log(`  • ${warning}`);
            });
        }
        
        if (this.stats.errors > 0) {
            console.log('\n❌ Some files could not be processed. Check the logs above for details.');
        }
        
        console.log('\n💡 Remember to test your upgraded VRM files in VRM 1.0 compatible applications!');
    }
}

// Main execution
async function main() {
    console.log('VRM Batch Upgrader v1.0');
    console.log('Upgrades VRM 0.x files to VRM 1.0 format\n');
    
    const processor = new BatchVrmProcessor();
    await processor.processDirectory();
}

// Run the script
if (require.main === module) {
    main().catch(error => {
        console.error('Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = { BatchVrmProcessor };
