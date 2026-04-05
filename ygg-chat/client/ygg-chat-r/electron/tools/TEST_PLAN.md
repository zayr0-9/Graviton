# ReadFile and EditFile Coordination - Test Cases

## Setup
Create a test file with known content for testing.

## Test 1: Read File with Metadata
- Read a file and verify metadata is returned
- Check that `contentHash`, `fileHash`, and `metadata` fields exist
- Verify `metadata.lineEnding` is detected correctly
- Verify `metadata.lastModified` is present

## Test 2: Multi-Range Read Without Phantom Headers
- Read multiple ranges from a file
- Verify NO `// Lines X-Y` comments in the returned content
- Verify range info is in the `ranges` metadata field only
- Content should match exactly what's in the actual file

## Test 3: Edit with Content Validation
- Read a file and capture its hash and metadata
- Attempt to edit the file passing the hash
- Verification should pass
- Edit should succeed

## Test 4: Edit with Stale Hash
- Read a file
- Modify the file externally
- Attempt to edit with old hash only
- Edit should still succeed because hash mismatches are advisory

## Test 5: Line Ending Preservation
- Create files with CRLF and LF line endings
- Read ranges from each
- Verify line endings are preserved in returned content
- Edit operations should preserve original line endings

## Test 6: Edit without Validation (Backward Compatibility)
- Call editFile with `validateContent: false`
- Should work without requiring hash or metadata
- Ensures backward compatibility with existing code

## Expected Results
All tests should pass, demonstrating:
- ✅ No phantom content in read results
- ✅ Metadata tracking works correctly
- ✅ Metadata validation prevents stale edits while stale hashes remain advisory
- ✅ Line endings preserved accurately
- ✅ Backward compatibility maintained
