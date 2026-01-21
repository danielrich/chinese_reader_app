import './style.css'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div class="container">
    <h1>Chinese Reader</h1>
    <p class="subtitle">A vocabulary tracking and reading comprehension assistant</p>

    <div class="features">
      <div class="feature">
        <h3>Vocabulary Tracking</h3>
        <p>Mark known and unknown words while reading</p>
      </div>
      <div class="feature">
        <h3>Anki Integration</h3>
        <p>Export words to Anki for spaced repetition review</p>
      </div>
      <div class="feature">
        <h3>Text Analysis</h3>
        <p>Analyze difficulty and vocabulary coverage of texts</p>
      </div>
      <div class="feature">
        <h3>Reading Progress</h3>
        <p>Track reading speed improvements over time</p>
      </div>
    </div>

    <p class="status">Application ready</p>
  </div>
`
