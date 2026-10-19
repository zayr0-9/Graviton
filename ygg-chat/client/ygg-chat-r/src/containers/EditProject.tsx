import { isHostClient } from '../platform/clientCapabilities'
import { selectHostFolder } from '../platform/hostPathPicker'
import { useQueryClient } from '@tanstack/react-query'
import { Cloud, Eraser, FolderOpen, HardDrive, Plus, Save, Sparkles, Star, X } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { Project, ProjectWithLatestConversation, StorageMode } from '../../../../shared/types'
import { Button, TextField } from '../components'
import { InputTextArea } from '../components/InputTextArea/InputTextArea'
import { getThemeModeColor, useCustomChatTheme, useHtmlDarkMode } from '../components/ThemeManager/themeConfig'
import { isCommunityMode } from '../config/runtimeMode'
import { createProject, CreateProjectPayload, updateProject, UpdateProjectPayload } from '../features/projects'
import { useAppDispatch } from '../hooks/redux'
import { useAuth } from '../hooks/useAuth'
import { useUserSystemPrompts } from '../hooks/useUserSystemPrompts'

interface EditProjectProps {
  isOpen: boolean
  onClose: () => void
  editingProject?: Project | null
  onProjectCreated?: (project: Project) => void
}

const glassIconButtonClass =
  'group/control relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/85 text-stone-700 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:scale-105 hover:bg-white hover:text-stone-950 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-yBlack-900/85 dark:text-stone-200 dark:hover:bg-neutral-900 dark:hover:text-white dark:focus-visible:ring-orange-400/70 dark:focus-visible:ring-offset-yBlack-900'
const glassPillClass = 'rounded-full bg-white/25 p-1.5 backdrop-blur-xl dark:bg-black/20'
const sectionCardClass = 'rounded-[2rem] bg-white/50 p-4 backdrop-blur-xl dark:bg-black/15 sm:p-5'
const fieldLabelClass = 'mb-2 block text-sm font-medium text-stone-700 dark:text-stone-200'
const fieldHintClass = 'mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400'
const inlineInputClass =
  'w-full rounded-2xl border-transparent bg-white/65 px-4 py-3 text-sm text-stone-900 outline-none backdrop-blur-xl transition focus:bg-white/80 focus:ring-2 focus:ring-blue-400/20 dark:bg-yBlack-900/65 dark:text-stone-100 dark:placeholder:text-stone-500 dark:focus:bg-yBlack-900/85 dark:focus:ring-orange-400/20'

type EditProjectThemeStyles = {
  backdrop: React.CSSProperties
  modal: React.CSSProperties
  chrome: React.CSSProperties
  section: React.CSSProperties
  primaryText: React.CSSProperties
  titleText: React.CSSProperties
  bodyText: React.CSSProperties
  mutedText: React.CSSProperties
  badge: React.CSSProperties
  inputSurface: React.CSSProperties
  panel: React.CSSProperties
  panelMuted: React.CSSProperties
  pillButton: React.CSSProperties
  activePillButton: React.CSSProperties
  primaryButton: React.CSSProperties
}

const EditProject: React.FC<EditProjectProps> = ({ isOpen, onClose, editingProject, onProjectCreated }) => {
  const dispatch = useAppDispatch()
  const queryClient = useQueryClient()
  const { userId } = useAuth()
  const { theme: customTheme, enabled: customThemeEnabled } = useCustomChatTheme()
  const isDarkMode = useHtmlDarkMode()

  const themedStyles: EditProjectThemeStyles | null = customThemeEnabled
    ? {
        backdrop: {
          backgroundColor: getThemeModeColor(customTheme.colors.authModalBackdrop, isDarkMode),
          color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
        },
        modal: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsPaneBodyBg, isDarkMode),
        },
        chrome: {
          backgroundColor: getThemeModeColor(customTheme.colors.conversationToolbarBg, isDarkMode),
        },
        section: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesCardBg, isDarkMode),
        },
        primaryText: {
          color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
        },
        titleText: {
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesTitleText, isDarkMode),
        },
        bodyText: {
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesBodyText, isDarkMode),
        },
        mutedText: {
          color: getThemeModeColor(customTheme.colors.toolJobsMutedText, isDarkMode),
        },
        badge: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesAccentBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesAccentText, isDarkMode),
        },
        inputSurface: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.toolJobsPrimaryText, isDarkMode),
        },
        panel: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesInnerCardBg, isDarkMode),
        },
        panelMuted: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesListBg, isDarkMode),
        },
        pillButton: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesButtonText, isDarkMode),
        },
        activePillButton: {
          backgroundColor: getThemeModeColor(customTheme.colors.composerToggleActiveBg, isDarkMode),
          borderColor: getThemeModeColor(customTheme.colors.composerToggleActiveBorder, isDarkMode),
          color: getThemeModeColor(customTheme.colors.composerToggleActiveText, isDarkMode),
        },
        primaryButton: {
          backgroundColor: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonBg, isDarkMode),
          color: getThemeModeColor(customTheme.colors.settingsCustomThemesPrimaryButtonText, isDarkMode),
        },
      }
    : null

  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectContext, setNewProjectContext] = useState('')
  const [newProjectSystemPrompt, setNewProjectSystemPrompt] = useState('')
  const [projectCwd, setProjectCwd] = useState('')
  const [storageMode, setStorageMode] = useState<StorageMode>(isCommunityMode ? 'local' : 'cloud')

  const isElectronMode = isHostClient

  const isEditing = Boolean(editingProject)
  const canSubmit = newProjectName.trim().length > 0

  const {
    prompts: userSystemPrompts,
    loading: promptsLoading,
    selectedPromptId,
    setSelectedPromptId,
    showSavePromptInput,
    setShowSavePromptInput,
    savePromptName,
    setSavePromptName,
    savePromptStorage,
    setSavePromptStorage,
    canSaveToCloud,
    savingPrompt,
    saveError,
    isExistingPrompt,
    matchingPrompt,
    makingDefault,
    removingDefault,
    handleSelectPrompt,
    handleSaveAsPrompt,
    handleMakeDefault,
    handleRemoveDefault,
    resetSaveUI,
  } = useUserSystemPrompts({
    currentPromptContent: newProjectSystemPrompt,
    isOpen,
    onPromptSelect: content => setNewProjectSystemPrompt(content),
  })

  useEffect(() => {
    if (editingProject) {
      setNewProjectName(editingProject.name)
      setNewProjectContext(editingProject.context || '')
      setNewProjectSystemPrompt(editingProject.system_prompt || '')
      setProjectCwd(editingProject.cwd || '')
      setStorageMode(isCommunityMode ? 'local' : editingProject.storage_mode || 'cloud')
      setSelectedPromptId(null)
    } else if (isOpen) {
      resetForm()
    }
  }, [editingProject, isOpen])

  const handleCreateProject = async () => {
    if (!canSubmit) return

    const normalizedProjectCwd = projectCwd.trim()
    const payload: CreateProjectPayload = {
      name: newProjectName.trim(),
      context: newProjectContext.trim() || undefined,
      system_prompt: newProjectSystemPrompt.trim() || undefined,
      cwd: normalizedProjectCwd || null,
      storageMode: isCommunityMode ? 'local' : storageMode,
    }

    try {
      const newProject = await dispatch(createProject(payload)).unwrap()
      resetForm()
      onClose()
      if (onProjectCreated) {
        onProjectCreated(newProject)
      }
    } catch (error) {
      console.error('Failed to create project:', error)
    }
  }

  const handleUpdateProject = async () => {
    if (!canSubmit || !editingProject) return

    const normalizedProjectCwd = projectCwd.trim()
    const payload: UpdateProjectPayload = {
      id: editingProject.id,
      name: newProjectName.trim(),
      context: newProjectContext.trim() || undefined,
      system_prompt: newProjectSystemPrompt.trim() || undefined,
      cwd: normalizedProjectCwd || null,
      storage_mode: isCommunityMode ? 'local' : storageMode,
    }

    try {
      const updatedProject = await dispatch(updateProject(payload)).unwrap()

      const updateProjectInCache = (projects: ProjectWithLatestConversation[] | undefined) => {
        if (!projects) return projects
        return projects.map(proj =>
          proj.id === updatedProject.id
            ? {
                ...proj,
                name: updatedProject.name,
                context: updatedProject.context,
                system_prompt: updatedProject.system_prompt,
                cwd: updatedProject.cwd ?? null,
                updated_at: updatedProject.updated_at,
              }
            : proj
        )
      }

      queryClient.setQueryData<ProjectWithLatestConversation[]>(['projects', userId], updateProjectInCache)
      queryClient.setQueryData<Project>(['projects', updatedProject.id], (old: Project | undefined) => {
        if (!old) return updatedProject
        return {
          ...old,
          name: updatedProject.name,
          context: updatedProject.context,
          system_prompt: updatedProject.system_prompt,
          cwd: updatedProject.cwd ?? null,
          updated_at: updatedProject.updated_at,
        }
      })

      resetForm()
      onClose()
    } catch (error) {
      console.error('Failed to update project:', error)
    }
  }

  const resetForm = () => {
    setNewProjectName('')
    setNewProjectContext('')
    setNewProjectSystemPrompt('')
    setProjectCwd('')
    setStorageMode(isCommunityMode ? 'local' : 'cloud')
    setSelectedPromptId(null)
    resetSaveUI()
  }

  const handleCancel = () => {
    resetForm()
    onClose()
  }

  const handleSelectProjectCwd = async () => {
    const result = await selectHostFolder(projectCwd)
    if (result.error) window.alert(result.error)
    if (result?.success && result.path) {
      setProjectCwd(result.path)
    }
  }

  const handleSubmit = isEditing ? handleUpdateProject : handleCreateProject
  const textInputStyle = themedStyles?.inputSurface
  const textAreaStyle = themedStyles?.inputSurface
  const sectionStyle = themedStyles?.section
  const panelStyle = themedStyles?.panel
  const panelMutedStyle = themedStyles?.panelMuted
  const mutedTextStyle = themedStyles?.mutedText
  const titleTextStyle = themedStyles?.titleText
  const bodyTextStyle = themedStyles?.bodyText
  const primaryTextStyle = themedStyles?.primaryText

  if (!isOpen) return null

  return (
    <div
      className='fixed inset-0 z-5000 flex items-center justify-center bg-stone-200/45 p-3 text-stone-900 backdrop-blur-xl dark:bg-black/45 dark:text-stone-100 sm:p-4'
      style={themedStyles?.backdrop}
    >
      <div
        className='flex h-full max-h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] bg-neutral-50/85 backdrop-blur-2xl dark:bg-yBlack-900/90'
        style={themedStyles?.modal}
      >
        <header
          className='sticky top-0 z-10 bg-neutral-50/80 px-5 py-4 backdrop-blur-2xl dark:bg-yBlack-900/80 sm:px-7'
          style={themedStyles?.chrome}
        >
          <div className='flex items-start justify-between gap-4'>
            <div className='min-w-0'>
              <div
                className='mb-2 inline-flex items-center gap-2 rounded-full bg-white/50 px-3 py-1 text-xs font-medium text-stone-500 backdrop-blur-xl dark:bg-white/5 dark:text-stone-400'
                style={themedStyles?.badge}
              >
                <Sparkles size={14} strokeWidth={2.25} />
                {isEditing ? 'Project settings' : 'New workspace'}
              </div>
              <h3 className='truncate text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50' style={primaryTextStyle}>
                {isEditing ? editingProject?.name : 'Create project'}
              </h3>
              <p className='mt-1 text-sm text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
                Keep project instructions, context, and storage preferences in one focused place.
              </p>
            </div>

            <div className={glassPillClass} style={panelMutedStyle}>
              <button type='button' onClick={handleCancel} className={glassIconButtonClass} style={themedStyles?.pillButton} title='Close' aria-label='Close'>
                <X size={18} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </header>

        <div className='thin-scrollbar flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6'>
          <div className='space-y-5'>
            <section className={sectionCardClass} style={sectionStyle}>
              <label className={fieldLabelClass} style={titleTextStyle}>Project name</label>
              <TextField
                placeholder='Name this project...'
                value={newProjectName}
                onChange={setNewProjectName}
                className='!rounded-2xl !border-transparent !bg-white/70 !py-3 !text-base dark:!border-transparent dark:!bg-yBlack-900/70'
                style={textInputStyle}
                autoFocus
              />
            </section>

            <section className={sectionCardClass} style={sectionStyle}>
              <div className='mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
                <div>
                  <label className={fieldLabelClass} style={titleTextStyle}>System prompt</label>
                  <p className='text-xs leading-5 text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
                    Optional behavior instructions for every chat in this project.
                  </p>
                </div>
                {promptsLoading && (
                  <span className='text-xs text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
                    Loading prompts...
                  </span>
                )}
              </div>

              {userSystemPrompts.length > 0 && (
                <div className='mb-4'>
                  <div className='thin-scrollbar flex gap-2 overflow-x-auto pb-1'>
                    {userSystemPrompts.map(prompt => {
                      const selected = selectedPromptId === prompt.id
                      return (
                        <button
                          key={prompt.id}
                          type='button'
                          onClick={() => handleSelectPrompt(prompt)}
                          className={`inline-flex h-10 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 dark:focus-visible:ring-orange-400/60 ${
                            selected
                              ? 'bg-blue-50 text-blue-700 dark:bg-orange-500/15 dark:text-orange-100'
                              : 'bg-white/55 text-stone-700 hover:bg-white dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10'
                          }`}
                          style={selected ? themedStyles?.activePillButton : themedStyles?.pillButton}
                          title={prompt.description || prompt.content.substring(0, 100)}
                          aria-pressed={selected}
                        >
                          <span className='max-w-44 truncate'>{prompt.name}</span>
                          {prompt.is_default && <Star size={14} strokeWidth={2.25} fill='currentColor' />}
                          <span
                            className='rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] opacity-70 dark:bg-white/10'
                            style={themedStyles?.panelMuted}
                          >
                            {prompt.storage_mode === 'local' ? 'Local' : 'Cloud'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              <InputTextArea
                placeholder='System prompt for this project...'
                value={newProjectSystemPrompt}
                onChange={val => {
                  setNewProjectSystemPrompt(val)
                  if (selectedPromptId) setSelectedPromptId(null)
                }}
                minRows={8}
                maxRows={12}
                width='w-full'
                showHelp={false}
                className='!rounded-[1.5rem] !bg-white/45 dark:!bg-yBlack-900/40'
                style={textAreaStyle}
              />

              {newProjectSystemPrompt.trim() && (
                <div className='mt-4'>
                  {isExistingPrompt ? (
                    matchingPrompt &&
                    (matchingPrompt.is_default ? (
                      <button
                        type='button'
                        onClick={handleRemoveDefault}
                        disabled={removingDefault}
                        className='inline-flex items-center gap-2 rounded-full bg-red-50/80 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-100 disabled:opacity-50 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/15'
                        style={themedStyles?.pillButton}
                      >
                        <Star size={16} strokeWidth={2.25} fill='currentColor' />
                        {removingDefault ? 'Removing...' : 'Remove default'}
                      </button>
                    ) : (
                      <button
                        type='button'
                        onClick={handleMakeDefault}
                        disabled={makingDefault}
                        className='inline-flex items-center gap-2 rounded-full bg-amber-50/80 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-100 disabled:opacity-50 dark:bg-orange-500/10 dark:text-orange-200 dark:hover:bg-orange-500/15'
                        style={themedStyles?.activePillButton}
                      >
                        <Star size={16} strokeWidth={2.25} />
                        {makingDefault ? 'Setting...' : 'Make default'}
                      </button>
                    ))
                  ) : !showSavePromptInput ? (
                    <button
                      type='button'
                      onClick={() => setShowSavePromptInput(true)}
                      className='inline-flex items-center gap-2 rounded-full bg-white/60 px-3 py-2 text-sm font-medium text-stone-700 transition hover:bg-white dark:bg-white/5 dark:text-stone-200 dark:hover:bg-white/10'
                      style={themedStyles?.pillButton}
                    >
                      <Save size={16} strokeWidth={2.25} />
                      Save as prompt
                    </button>
                  ) : (
                    <div className='rounded-[1.5rem] bg-white/50 p-3 dark:bg-white/5' style={panelStyle}>
                      <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
                        <input
                          type='text'
                          value={savePromptName}
                          onChange={e => setSavePromptName(e.target.value)}
                          placeholder='Prompt name...'
                          maxLength={100}
                          className={inlineInputClass}
                          style={textInputStyle}
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleSaveAsPrompt()
                            if (e.key === 'Escape') resetSaveUI()
                          }}
                        />
                        <div className='flex shrink-0 items-center gap-1 rounded-full bg-white/55 p-1 dark:bg-white/5' style={panelMutedStyle}>
                          {(['local', 'cloud'] as const).map(storage => (
                            <button
                              key={storage}
                              type='button'
                              onClick={() => setSavePromptStorage(storage)}
                              disabled={storage === 'cloud' && !canSaveToCloud}
                              className={`rounded-full px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                savePromptStorage === storage
                                  ? 'bg-white text-blue-700 shadow-sm dark:bg-yBlack-900/80 dark:text-orange-100'
                                  : 'text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100'
                              }`}
                              style={savePromptStorage === storage ? themedStyles?.activePillButton : themedStyles?.mutedText}
                              title={storage === 'local' ? 'Save only on this device' : 'Save to cloud account'}
                            >
                              {storage === 'local' ? 'Local' : 'Cloud'}
                            </button>
                          ))}
                        </div>
                        <Button
                          type='button'
                          variant='outline2'
                          size='small'
                          rounded='full'
                          onClick={handleSaveAsPrompt}
                          disabled={!savePromptName.trim() || savingPrompt}
                          className='group shrink-0 border-transparent bg-white/70 px-4 dark:bg-white/5'
                        >
                          <span className='transition-transform duration-100 group-active:scale-95'>
                            {savingPrompt ? 'Saving...' : 'Save'}
                          </span>
                        </Button>
                        <button
                          type='button'
                          onClick={resetSaveUI}
                          className={glassIconButtonClass}
                          style={themedStyles?.pillButton}
                          title='Cancel save prompt'
                          aria-label='Cancel save prompt'
                        >
                          <X size={16} strokeWidth={2.25} />
                        </button>
                      </div>
                      <p className='mt-2 text-xs text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
                        {savePromptStorage === 'local'
                          ? 'Local prompts stay on this device.'
                          : 'Cloud prompts sync with your account.'}
                      </p>
                      {saveError && <p className='mt-2 text-sm text-red-500 dark:text-red-400'>{saveError}</p>}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className={sectionCardClass} style={sectionStyle}>
              <label className={fieldLabelClass} style={titleTextStyle}>Context</label>
              <p className='mb-4 text-xs leading-5 text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
                Optional background, goals, repository notes, or operating assumptions for this project.
              </p>
              <InputTextArea
                placeholder='Project context or description...'
                value={newProjectContext}
                onChange={setNewProjectContext}
                minRows={9}
                maxRows={16}
                width='w-full'
                showHelp={false}
                className='!rounded-[1.5rem] !bg-white/45 dark:!bg-yBlack-900/40'
                style={textAreaStyle}
              />
            </section>

            {isElectronMode && (
              <section className={sectionCardClass} style={sectionStyle}>
                <label className={fieldLabelClass} style={titleTextStyle}>Working directory</label>
                <div className='flex flex-col gap-2 sm:flex-row'>
                  <input
                    type='text'
                    value={projectCwd}
                    onChange={event => setProjectCwd(event.target.value)}
                    placeholder='Optional default cwd for new local chats'
                    className={inlineInputClass}
                    style={textInputStyle}
                    title='Default working directory inherited by new local chats in this project'
                  />
                  <div className={`${glassPillClass} flex w-fit items-center gap-2`} style={panelMutedStyle}>
                    <button
                      type='button'
                      onClick={handleSelectProjectCwd}
                      className={glassIconButtonClass}
                      style={themedStyles?.pillButton}
                      title='Select project working directory'
                      aria-label='Select project working directory'
                    >
                      <FolderOpen size={18} strokeWidth={2.25} />
                    </button>
                    {projectCwd.trim() && (
                      <button
                        type='button'
                        onClick={() => setProjectCwd('')}
                        className={glassIconButtonClass}
                        style={themedStyles?.pillButton}
                        title='Clear project working directory'
                        aria-label='Clear project working directory'
                      >
                        <Eraser size={18} strokeWidth={2.25} />
                      </button>
                    )}
                  </div>
                </div>
                <p className={fieldHintClass} style={mutedTextStyle}>New local chats inherit this cwd. Existing chats keep their own cwd.</p>
              </section>
            )}

            {isElectronMode && (
              <section className={sectionCardClass} style={sectionStyle}>
                <label className={fieldLabelClass} style={titleTextStyle}>Storage location</label>
                <div className='grid gap-3 sm:grid-cols-2'>
                  {!isCommunityMode && (
                    <button
                      type='button'
                      onClick={() => setStorageMode('cloud')}
                      className={`rounded-[1.5rem] p-4 text-left transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] ${
                        storageMode === 'cloud'
                          ? 'bg-blue-50/80 text-blue-800 dark:bg-orange-500/15 dark:text-orange-100'
                          : 'bg-white/45 text-stone-700 hover:bg-white dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10'
                      }`}
                      style={storageMode === 'cloud' ? themedStyles?.activePillButton : panelStyle}
                      aria-pressed={storageMode === 'cloud'}
                    >
                      <span className='mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/45 dark:bg-black/10' style={panelMutedStyle}>
                        <Cloud size={18} strokeWidth={2.25} />
                      </span>
                      <span className='block font-medium'>Cloud</span>
                      <span className='mt-1 block text-sm leading-5 opacity-75' style={bodyTextStyle}>Synced anywhere. No agent support.</span>
                    </button>
                  )}
                  <button
                    type='button'
                    onClick={() => setStorageMode('local')}
                    className={`rounded-[1.5rem] p-4 text-left transition-all duration-200 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] ${
                      storageMode === 'local'
                        ? 'bg-blue-50/80 text-blue-800 dark:bg-orange-500/15 dark:text-orange-100'
                        : 'bg-white/45 text-stone-700 hover:bg-white dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10'
                    }`}
                    style={storageMode === 'local' ? themedStyles?.activePillButton : panelStyle}
                    aria-pressed={storageMode === 'local'}
                  >
                    <span className='mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/45 dark:bg-black/10' style={panelMutedStyle}>
                      <HardDrive size={18} strokeWidth={2.25} />
                    </span>
                    <span className='block font-medium'>Local only</span>
                    <span className='mt-1 block text-sm leading-5 opacity-75' style={bodyTextStyle}>Stored on this device. Supports agent.</span>
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>

        <footer className='bg-neutral-50/80 px-5 py-4 backdrop-blur-2xl dark:bg-yBlack-900/80 sm:px-7' style={themedStyles?.chrome}>
          <div className='flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between'>
            <p className='text-xs text-stone-500 dark:text-stone-400' style={mutedTextStyle}>
              {canSubmit ? 'Ready to save.' : 'Add a project name to continue.'}
            </p>
            <div className='flex justify-end gap-2'>
              <Button
                variant='outline2'
                size='small'
                rounded='full'
                className='group px-5 py-2.5'
                onClick={handleCancel}
              >
                <span className='transition-transform duration-100 group-active:scale-95'>Cancel</span>
              </Button>
              <Button
                variant='outline'
                size='small'
                rounded='full'
                disabled={!canSubmit}
                className='group border-transparent bg-white/70 px-5 py-2.5 dark:border-transparent dark:bg-white/5'
                onClick={handleSubmit}
              >
                <span className='inline-flex items-center gap-2 transition-transform duration-100 group-active:scale-95'>
                  {isEditing ? <Save size={16} strokeWidth={2.25} /> : <Plus size={16} strokeWidth={2.25} />}
                  {isEditing ? 'Update project' : 'Create project'}
                </span>
              </Button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}

export default EditProject
