const fs = require('fs');
const path = require('path');
const FbxToVrmaConverter = require('./fbx-to-vrma.js');

async function ConvertAllFbxFiles() {
    const inputDir = path.join('assets', 'fbx');
    const outputDir = path.join('assets', 'vrma');
    
    // Check if input directory exists
    if (!fs.existsSync(inputDir)) {
        console.error(`Input directory not found: ${inputDir}`);
        console.log('Creating directory...');
        fs.mkdirSync(inputDir, { recursive: true });
        console.log(`Please place your FBX files in: ${inputDir}`);
        return;
    }
    
    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created output directory: ${outputDir}`);
    }
    
    // Get all FBX files
    const files = fs.readdirSync(inputDir);
    const fbxFiles = files.filter(file => 
        file.toLowerCase().endsWith('.fbx')
    );
    
    if (fbxFiles.length === 0) {
        console.log(`No FBX files found in ${inputDir}`);
        return;
    }
    
    console.log(`Found ${fbxFiles.length} FBX file(s) to convert:\n`);
    
    const converter = new FbxToVrmaConverter();
    let successCount = 0;
    let failCount = 0;
    
    // Convert each file
    for (const fbxFile of fbxFiles) {
        const inputPath = path.join(inputDir, fbxFile);
        const outputFileName = path.basename(fbxFile, '.fbx') + '.vrma';
        const outputPath = path.join(outputDir, outputFileName);
        
        console.log(`\n[${successCount + failCount + 1}/${fbxFiles.length}] Converting: ${fbxFile}`);
        console.log(`  Output: ${outputFileName}`);
        
        try {
            converter.Convert(inputPath, outputPath);
            successCount++;
        } catch (error) {
            console.error(`  ❌ Failed: ${error.message}`);
            failCount++;
        }
    }
    
    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('Conversion Summary:');
    console.log(`  ✅ Successful: ${successCount}`);
    console.log(`  ❌ Failed: ${failCount}`);
    console.log(`  📁 Output directory: ${outputDir}`);
    console.log('='.repeat(50));
}

// Run the batch conversion
ConvertAllFbxFiles().catch(error => {
    console.error('Batch conversion error:', error);
    process.exit(1);
});
