# Remove Duplicate Photos

## Quick Guide

```bash
# 1. Check if you have duplicates
entoder verify

# 2. Remove them (safe - goes to trash)
entoder verify --fix --yes
```

## What This Does

The verify command finds and removes duplicate photos from your Ente account.

- ✅ Finds exact duplicate files
- ✅ Keeps the original (first uploaded)
- ✅ Removes the extras
- ✅ Moves duplicates to trash (not permanently deleted)

## Step by Step

### Step 1: Check for Duplicates

```bash
entoder verify
```

This will show you:

```
Total photos:     10,000
Unique photos:     9,500
Duplicates found:    500
Wasted space:     2.5GB
```

### Step 2: Remove Duplicates

```bash
entoder verify --fix --yes
```

This will:

- Move 500 duplicate files to trash
- Keep the original copy of each photo
- Free up 2.5GB of space (after you empty trash)

## Don't Forget!

⚠️ The tool moves files to trash, not permanently deletes them.

To actually free up space:

1. Open Ente Photos app or website
2. Go to trash
3. Empty trash

## When to Use This

**Good times to check:**

- After uploading a large number of photos
- Once a month as routine maintenance
- If you notice duplicate photos in your albums

**It's safe to run anytime** - checking for duplicates doesn't change anything.

## Need Your Password?

Add your email and password:

```bash
entoder verify --email your@email.com --password yourpassword
```

Or set them once:

```bash
# Mac/Linux
export ENTE_EMAIL=your@email.com
export ENTE_PASSWORD=yourpassword

# Windows
$env:ENTE_EMAIL="your@email.com"
$env:ENTE_PASSWORD="yourpassword"
```

Then just run:

```bash
entoder verify
```

## What You'll See

**If no duplicates:**

```
✅ No duplicates found! All files are unique.
```

**If duplicates found:**

```
Found 500 duplicate files
Wasted storage: 2.5GB

Run with --fix --yes to remove them
```

**While removing:**

```
Deleting duplicates...
Deleted 100/500 files...
Deleted 500/500 files...
✅ Done! Removed 500 duplicates
```

## Questions

**Will this delete my photos?**
No - it only removes exact duplicates and keeps one copy of each photo.

**Can I undo this?**
Yes - duplicates go to trash first. Check trash before emptying it.

**How long does it take?**

- Small library (1,000 photos): ~1 minute
- Medium library (10,000 photos): ~5 minutes
- Large library (100,000 photos): ~15 minutes

**What if something goes wrong?**
The process is safe - it only moves files to trash, never permanently deletes them.
